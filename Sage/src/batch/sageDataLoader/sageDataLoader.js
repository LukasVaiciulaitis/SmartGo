// sageDataLoader.js
// Called as the first Step Functions step.
// Reads modelType ('road' | 'rail') from the execution input and routes accordingly.
// 1. Lists daily consolidated CSVs from the model-specific Dagon prefix.
// 2. Filters to a rolling 52-week window (one full seasonal cycle).
// 3. Appends any CSVs present in imports/{modelType}/ (manual one-time additions,
//    not subject to the rolling window -- present until manually removed).
// 4. Writes the combined dataset to the model-specific Sage bucket prefix.
//    The model script performs the internal train/val split -- no split done here.
// 5. Ensures the model script tarball is in the Sage bucket; uploaded once per deploy.
// Returns: { bucketName, dataUri, codeUri, modelType, sagemakerProgram }

const { s3GetBuffer, s3Put, s3Exists, s3ListKeys } = require('/opt/nodejs/utils');
const fs = require('fs').promises;

const SAGE_BUCKET  = process.env.SAGE_BUCKET;
const DAGON_BUCKET = process.env.DAGON_BUCKET;

// ─── Model configuration ──────────────────────────────────────────────────────
// Add a new entry here when a new model type is introduced.
// dagonPrefix:      S3 prefix in the Dagon bucket for this model's consolidated CSVs.
// outputPrefix:     S3 prefix in the Sage bucket for processed training data.
// importPrefix:     S3 prefix in the Sage bucket for manual one-time import CSVs.
//                   Upload any CSV with the correct schema here to include it in every
//                   training run. Files persist until manually deleted -- no lifecycle rule.
// codeKey:          S3 key in the Sage bucket for the model script tarball.
// layerTarball:     Path to the model script tarball in the Lambda layer (/opt/logic/).
// sagemakerProgram: Script filename passed to SageMaker as sagemaker_program.

const MODEL_CONFIG = {
  road: {
    dagonPrefix:      'consolidated/',               // current Dagon road data prefix
    outputPrefix:     'processed/road',
    importPrefix:     'imports/road/',
    codeKey:          'code/road/sageRoadModel.tar.gz',
    layerTarball:     '/opt/logic/sageRoadModel.tar.gz',
    sagemakerProgram: 'sageRoadModel.py',
  },
  rail: {
    dagonPrefix:      'consolidated/rail/',
    outputPrefix:     'processed/rail',
    importPrefix:     'imports/rail/',
    codeKey:          'code/rail/sageRailModel.tar.gz',
    layerTarball:     '/opt/logic/sageRailModel.tar.gz',
    sagemakerProgram: 'sageRailModel.py',
  },
};

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split('\n').filter(l => l.trim());
  const headers = lines[0].split(',');
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] ?? '').trim(); });
    return row;
  });
}

function toCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => row[h] ?? '').join(','));
  return lines.join('\n');
}

// ─── Dagon data ingest ────────────────────────────────────────────────────────

// Extract the YYYY-MM-DD date from a Dagon/cache S3 key containing date=YYYY-MM-DD.
function extractDate(key) {
  const m = key.match(/date=(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

async function loadRollingWindow(config) {
  // Rolling 52-week cutoff -- one full seasonal cycle of commute data.
  // Older data is less representative (road network changes, new developments)
  // and grows the training set unboundedly without proportional benefit.
  const cutoff = new Date(Date.now() - 52 * 7 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10); // 'YYYY-MM-DD'

  const allKeys = await s3ListKeys(DAGON_BUCKET, config.dagonPrefix);
  if (!allKeys.length) {
    console.log(`No consolidated CSVs found in s3://${DAGON_BUCKET}/${config.dagonPrefix} -- training will rely on imports only`);
    return [];
  }

  // Filter to keys within the rolling window using the date= partition in the key.
  const windowKeys = allKeys.filter(key => {
    const date = extractDate(key);
    return date && date >= cutoff;
  });

  if (!windowKeys.length) {
    console.log(`No Dagon data found within the 52-week window (cutoff ${cutoff}) -- training will rely on imports only`);
    return [];
  }

  // Delta detection: each daily CSV is cached in the Sage bucket once it has been
  // downloaded. Subsequent runs read from the cache rather than re-fetching from Dagon.
  // Cache key: processed/{modelType}/daily/date=YYYY-MM-DD/commutes.csv
  // The cache accumulates indefinitely; the window filter below limits what is read.
  const cachePrefix = `${config.outputPrefix}/daily/`;
  const cachedKeys  = await s3ListKeys(SAGE_BUCKET, cachePrefix);
  const cachedDates = new Set(cachedKeys.map(extractDate).filter(Boolean));

  const uncachedKeys = windowKeys.filter(key => !cachedDates.has(extractDate(key)));

  if (uncachedKeys.length > 0) {
    console.log(`Downloading ${uncachedKeys.length} new daily CSV(s) from Dagon (${windowKeys.length - uncachedKeys.length} already cached)`);
    await Promise.all(uncachedKeys.map(async key => {
      const date     = extractDate(key);
      const cacheKey = `${cachePrefix}date=${date}/commutes.csv`;
      const buf      = await s3GetBuffer(DAGON_BUCKET, key);
      await s3Put(SAGE_BUCKET, cacheKey, buf, 'text/csv');
    }));
  } else {
    console.log(`All ${windowKeys.length} daily CSV(s) already cached -- no Dagon downloads needed`);
  }

  // Read the full window from the Sage cache in batches of 20.
  // Batching limits concurrent S3 connections; parsing each file immediately and
  // discarding the raw text avoids holding all CSV content in memory alongside
  // the growing rows array (up to ~364 files after a year of daily Dagon runs).
  console.log(`Assembling training data from ${windowKeys.length} cached CSV(s) (cutoff ${cutoff})`);
  const allRows = [];
  for (let i = 0; i < windowKeys.length; i += 20) {
    const batch = windowKeys.slice(i, i + 20);
    const texts = await Promise.all(
      batch.map(key => {
        const cacheKey = `${cachePrefix}date=${extractDate(key)}/commutes.csv`;
        return s3GetBuffer(SAGE_BUCKET, cacheKey).then(buf => buf.toString('utf-8'));
      })
    );
    for (const text of texts) allRows.push(...parseCSV(text));
  }

  return allRows;
}

// ─── Manual imports ───────────────────────────────────────────────────────────

async function loadImports(config) {
  // Manual import CSVs -- upload to imports/{modelType}/ in the Sage bucket to include
  // historical, synthetic, or test data in every training run.
  //
  // Delta detection: same pattern as Dagon files. New import files are copied from
  // imports/{modelType}/ to processed/{modelType}/imported/ on first encounter.
  // Subsequent runs read from the cache -- the imports/ prefix is the upload zone only.
  // Matching is by filename. To force a re-import of an updated file: delete it from
  // processed/{modelType}/imported/ and the next run will re-copy it.
  //
  // No date= convention required. No lifecycle rule -- files persist until manually deleted.
  const importKeys = await s3ListKeys(SAGE_BUCKET, config.importPrefix);
  if (!importKeys.length) return [];

  const importedPrefix = `${config.outputPrefix}/imported/`;
  const importedKeys   = await s3ListKeys(SAGE_BUCKET, importedPrefix);
  const importedNames  = new Set(importedKeys.map(k => k.split('/').pop()).filter(Boolean));

  const newImportKeys = importKeys.filter(k => !importedNames.has(k.split('/').pop()));
  if (newImportKeys.length > 0) {
    console.log(`Caching ${newImportKeys.length} new import file(s) to ${importedPrefix} (${importedKeys.length} already cached)`);
    await Promise.all(newImportKeys.map(async key => {
      const filename  = key.split('/').pop();
      const cachedKey = `${importedPrefix}${filename}`;
      const buf       = await s3GetBuffer(SAGE_BUCKET, key);
      await s3Put(SAGE_BUCKET, cachedKey, buf, 'text/csv');
    }));
  } else {
    console.log(`All ${importedKeys.length} import file(s) already cached -- no copies needed`);
  }

  // Read all cached imports (existing + newly copied).
  const allCachedKeys = [
    ...importedKeys,
    ...newImportKeys.map(k => `${importedPrefix}${k.split('/').pop()}`),
  ];

  console.log(`Reading ${allCachedKeys.length} cached import file(s)`);
  const importRows = [];
  for (let i = 0; i < allCachedKeys.length; i += 20) {
    const batch = allCachedKeys.slice(i, i + 20);
    const texts = await Promise.all(
      batch.map(key => s3GetBuffer(SAGE_BUCKET, key).then(buf => buf.toString('utf-8')))
    );
    for (const text of texts) importRows.push(...parseCSV(text));
  }
  return importRows;
}

// ─── Code tarball ─────────────────────────────────────────────────────────────

async function ensureCodeTarball(config) {
  // The model script tarball is built by the deploy-sage workflow and mounted at
  // /opt/logic/ via LogicLayer. Only upload to S3 on first run after a deploy.
  if (await s3Exists(SAGE_BUCKET, config.codeKey)) {
    console.log(`Code tarball already present at ${config.codeKey} -- skipping upload`);
    return `s3://${SAGE_BUCKET}/${config.codeKey}`;
  }

  console.log(`Code tarball not found at ${config.codeKey} -- uploading`);
  const tarBuf = await fs.readFile(config.layerTarball);
  await s3Put(SAGE_BUCKET, config.codeKey, tarBuf, 'application/x-tar');
  console.log(`Code tarball uploaded to s3://${SAGE_BUCKET}/${config.codeKey}`);
  return `s3://${SAGE_BUCKET}/${config.codeKey}`;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const modelType = event.modelType;
    if (!modelType || !MODEL_CONFIG[modelType]) {
      throw new Error(`Invalid or missing modelType '${modelType}'. Must be one of: ${Object.keys(MODEL_CONFIG).join(', ')}`);
    }

    const config        = MODEL_CONFIG[modelType];
    const executionName = event.executionName ?? `manual-${Date.now()}`;

    console.log(`sageDataLoader invoked -- modelType="${modelType}" executionName="${executionName}"`);

    // 1. Load rolling 52-week window of Dagon data for this model type
    const rows = await loadRollingWindow(config);
    if (rows.length > 0) console.log(`Loaded ${rows.length} rows across rolling 52-week window`);

    // 1b. Append any manual import CSVs (run in parallel with nothing -- loadImports
    //     is independent of loadRollingWindow's output so we could parallelise, but
    //     the rolling window dominates runtime so sequential is fine here)
    const importRows = await loadImports(config);
    if (importRows.length > 0) {
      rows.push(...importRows);
      console.log(`Appended ${importRows.length} import row(s) -- total ${rows.length} rows`);
    }

    if (rows.length === 0) {
      throw new Error(`No training data found for modelType="${modelType}" -- consolidated/ is empty and no imports present`);
    }

    // 2. Write full dataset to model-specific Sage bucket prefix.
    // Assembled training CSVs live under runs/ so lifecycle rules can target them
    // independently of the daily cache (processed/{modelType}/daily/).
    const dataKey = `${config.outputPrefix}/runs/${executionName}/train/train.csv`;
    await s3Put(SAGE_BUCKET, dataKey, toCSV(rows), 'text/csv');

    // 3. Ensure model script tarball is in the Sage bucket (uploaded once per deploy)
    const codeUri = await ensureCodeTarball(config);

    const dataUri = `s3://${SAGE_BUCKET}/${config.outputPrefix}/runs/${executionName}/train/`;

    console.log(`sageDataLoader complete -- modelType="${modelType}" rows=${rows.length} dataUri="${dataUri}" codeUri="${codeUri}"`);

    return {
      bucketName:       SAGE_BUCKET,
      dataUri,
      codeUri,
      modelType,
      sagemakerProgram: config.sagemakerProgram,
    };
  } catch (err) {
    console.error('sageDataLoader error:', err);
    throw err;
  }
};
