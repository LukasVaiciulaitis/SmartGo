// sageWorker.js
// Called as the third Step Functions step (after SageMaker training completes).
// Reads modelType ('road' | 'rail') from the event and routes endpoint/SSM accordingly.
// 1. Reads evaluation.json from S3 (written directly by the model script via boto3).
// 2. Applies gate thresholds: calibrated RMSE ≤ 600s AND |bias| ≤ 200s.
// 3. Writes global calibration params and summary metrics to model-specific SSM paths.
// 4. If gate fails: throws GateNotPassedError (Step Functions routes to GateFailed state).
// 5. If gate passes: creates or updates the model-specific SageMaker endpoint.
//    The model script copies itself into /opt/ml/model/ during training, so model.tar.gz
//    already contains the serving hooks -- no separate injection step needed.

const { s3GetJson, s3AppendJsonl, ssmPut } = require('/opt/nodejs/utils');
const {
  SageMakerClient,
  CreateModelCommand,
  CreateEndpointConfigCommand,
  CreateEndpointCommand,
  UpdateEndpointCommand,
  DescribeEndpointCommand,
  DescribeEndpointConfigCommand,
  DeleteModelCommand,
  DeleteEndpointConfigCommand,
} = require('@aws-sdk/client-sagemaker');

const sm = new SageMakerClient({});

const SAGE_BUCKET    = process.env.SAGE_BUCKET;
const TRAINING_IMAGE = process.env.TRAINING_IMAGE;
const SAGEMAKER_ROLE = process.env.SAGEMAKER_ROLE_ARN;

const GATE_RMSE = 600;
const GATE_BIAS = 200;

// ─── Model configuration ──────────────────────────────────────────────────────
// Add a new entry here when a new model type is introduced.
// endpointName:     SageMaker serverless endpoint to create or update.
// ssmCalibration:   SSM path for the global calibration fallback params.
// ssmEvaluation:    SSM path for last evaluation metrics summary.
// sagemakerProgram: Script filename set as SAGEMAKER_PROGRAM in the endpoint container.

const MODEL_CONFIG = {
  road: {
    endpointName:     'smartgo-road-endpoint',
    ssmCalibration:   '/smartgo/sage/road/globalCalibration',
    ssmEvaluation:    '/smartgo/sage/road/lastEvaluation',
    s3History:        'history/road/evaluations.jsonl',
    sagemakerProgram: 'sageRoadModel.py',
  },
  rail: {
    endpointName:     'smartgo-rail-endpoint',
    ssmCalibration:   '/smartgo/sage/rail/globalCalibration',
    ssmEvaluation:    '/smartgo/sage/rail/lastEvaluation',
    s3History:        'history/rail/evaluations.jsonl',
    sagemakerProgram: 'sageRailModel.py',
  },
};

// ─── Gate error ───────────────────────────────────────────────────────────────

class GateNotPassedError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'GateNotPassedError';
  }
}

// ─── SageMaker endpoint management ───────────────────────────────────────────

async function endpointExists(name) {
  try {
    await sm.send(new DescribeEndpointCommand({ EndpointName: name }));
    return true;
  } catch (err) {
    // SageMaker throws ValidationException (older SDK) or ResourceNotFoundException (newer)
    // when the endpoint does not exist. The message check is belt-and-suspenders in case
    // the error class name changes across SDK versions.
    if (err.name === 'ValidationException' ||
        err.name === 'ResourceNotFoundException' ||
        err.message?.includes('Could not find')) return false;
    throw err;
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  try {
    const modelType     = event.modelType;
    const jobName       = event.jobName;
    const modelArtifact = event.modelArtifact;
    const bucketName    = event.bucketName ?? SAGE_BUCKET;

    if (!modelType || !MODEL_CONFIG[modelType]) {
      throw new Error(`Invalid or missing modelType '${modelType}'. Must be one of: ${Object.keys(MODEL_CONFIG).join(', ')}`);
    }
    if (!jobName)       throw new Error('Missing jobName in event -- required to locate evaluation.json and name SageMaker resources');
    if (!modelArtifact) throw new Error('Missing modelArtifact in event -- required as ModelDataUrl for the SageMaker endpoint');

    const config = MODEL_CONFIG[modelType];
    console.log(`sageWorker invoked -- modelType="${modelType}" job="${jobName}" bucket="${bucketName}"`);

    // 1. Read evaluation.json written by the model script
    const evalKey = `evaluations/${jobName}/evaluation.json`;
    let evaluation;
    try {
      evaluation = await s3GetJson(bucketName, evalKey);
    } catch (err) {
      console.error(`Failed to read evaluation.json from s3://${bucketName}/${evalKey}:`, err.message);
      throw new Error(`evaluation.json not found for job ${jobName}. Did the model script write it?`);
    }

    const { calibrated_rmse, calibrated_bias, calibrated_mae, within_300s_pct, ci_coverage,
            global_slope, global_intercept, n_val, n_segments } = evaluation;

    // Validate gate fields are finite numbers before use -- a malformed evaluation.json
    // (NaN, null, missing key) would otherwise produce a TypeError on .toFixed() or silently
    // write bad calibration params to SSM that delayWorker would then use for predictions.
    const requiredNumbers = { calibrated_rmse, calibrated_bias, global_slope, global_intercept };
    for (const [field, val] of Object.entries(requiredNumbers)) {
      if (typeof val !== 'number' || !isFinite(val)) {
        throw new Error(`evaluation.json field '${field}' is not a finite number (got ${JSON.stringify(val)}) -- model script may have written NaN or null`);
      }
    }

    // 2. Apply gate thresholds
    const rmseOk   = calibrated_rmse <= GATE_RMSE;
    const biasOk   = Math.abs(calibrated_bias) <= GATE_BIAS;
    const gatePass = rmseOk && biasOk;

    console.log(`Metrics: RMSE=${calibrated_rmse.toFixed(1)}s (gate≤${GATE_RMSE}s: ${rmseOk ? 'PASS' : 'FAIL'}) bias=${calibrated_bias.toFixed(1)}s (gate|bias|≤${GATE_BIAS}s: ${biasOk ? 'PASS' : 'FAIL'}) gate=${gatePass ? 'PASS' : 'FAIL'}`);

    // 3. Write SSM params and append to evaluation history regardless of gate outcome.
    const evaluatedAt = new Date().toISOString();
    const evalRecord  = {
      jobName,
      rmse:        calibrated_rmse,
      bias:        calibrated_bias,
      mae:         calibrated_mae,
      within300:   within_300s_pct,
      ciCoverage:  ci_coverage,
      nVal:        n_val,
      nSegments:   n_segments,
      gatePass,
      evaluatedAt,
    };

    await Promise.all([
      ssmPut(
        config.ssmCalibration,
        JSON.stringify({ slope: global_slope, intercept: global_intercept }),
        `Global calibration written by sageWorker for ${modelType} job ${jobName}`,
      ),
      ssmPut(config.ssmEvaluation, JSON.stringify(evalRecord)),
      s3AppendJsonl(SAGE_BUCKET, config.s3History, evalRecord),
    ]);

    // 4. Gate check -- throw so Step Functions routes to GateFailed
    if (!gatePass) {
      throw new GateNotPassedError(
        `Gate thresholds not met for ${modelType} job ${jobName}: RMSE=${calibrated_rmse.toFixed(1)}s bias=${calibrated_bias.toFixed(1)}s`,
      );
    }

    // 5. Read old config/model names from the live endpoint so we can delete them after
    // the update. Both model and config are job-scoped (suffixed with jobName) so each
    // run creates fresh resources pointing at the new artifact. The old pair is deleted
    // after UpdateEndpoint accepts the new config -- at that point they are detached and
    // SageMaker allows deletion. Failures here are non-fatal; orphaned configs/models
    // are harmless (no billing for unused SageMaker configs or models) and will be
    // cleaned up on the next successful pipeline run.
    console.log(`sageWorker gate passed -- deploying modelType="${modelType}" artifact="${modelArtifact}"`);
    const { endpointName } = config;
    const exists = await endpointExists(endpointName);

    let oldConfigName = null;
    let oldModelName  = null;
    if (exists) {
      try {
        const endpointDesc = await sm.send(new DescribeEndpointCommand({ EndpointName: endpointName }));
        oldConfigName = endpointDesc.EndpointConfigName ?? null;
        if (oldConfigName) {
          const configDesc = await sm.send(new DescribeEndpointConfigCommand({ EndpointConfigName: oldConfigName }));
          oldModelName = configDesc.ProductionVariants?.[0]?.ModelName ?? null;
        }
        console.log(`Captured old resources for cleanup: config=${oldConfigName} model=${oldModelName}`);
      } catch (err) {
        console.warn(`Could not read old endpoint resources for cleanup -- non-fatal: ${err.message}`);
      }
    }

    // 6. Create new job-scoped model and endpoint config
    const modelName  = `smartgo-${modelType}-${jobName}`;
    const configName = `smartgo-${modelType}-cfg-${jobName}`;

    await sm.send(new CreateModelCommand({
      ModelName:        modelName,
      PrimaryContainer: {
        Image:        TRAINING_IMAGE,
        ModelDataUrl: modelArtifact,
        Environment: {
          SAGEMAKER_PROGRAM:             config.sagemakerProgram,
          SAGEMAKER_SUBMIT_DIRECTORY:    '/opt/ml/model',
          SAGEMAKER_CONTAINER_LOG_LEVEL: '20',
        },
      },
      ExecutionRoleArn: SAGEMAKER_ROLE,
      Tags: [
        { Key: 'Project',     Value: 'SmartGo' },
        { Key: 'ModelType',   Value: modelType },
        { Key: 'TrainingJob', Value: jobName },
      ],
    }));
    console.log(`Created SageMaker model: ${modelName}`);

    await sm.send(new CreateEndpointConfigCommand({
      EndpointConfigName: configName,
      ProductionVariants: [{
        VariantName:  'AllTraffic',
        ModelName:    modelName,
        ServerlessConfig: {
          MemorySizeInMB: 2048,
          MaxConcurrency: 10,
        },
      }],
      Tags: [
        { Key: 'Project',   Value: 'SmartGo' },
        { Key: 'ModelType', Value: modelType },
      ],
    }));
    console.log(`Created endpoint config: ${configName}`);

    // 7. Create or update the fixed-name endpoint, then clean up old resources
    if (exists) {
      await sm.send(new UpdateEndpointCommand({
        EndpointName:       endpointName,
        EndpointConfigName: configName,
      }));
      console.log(`Updated endpoint: ${endpointName}`);
    } else {
      await sm.send(new CreateEndpointCommand({
        EndpointName:       endpointName,
        EndpointConfigName: configName,
        Tags: [
          { Key: 'Project',   Value: 'SmartGo' },
          { Key: 'ModelType', Value: modelType },
        ],
      }));
      console.log(`Created endpoint: ${endpointName}`);
    }

    // Delete the previous config and model now that the endpoint has accepted the new config.
    // Order matters: config must be deleted before model (model deletion fails while any
    // config still references it).
    if (oldConfigName && oldConfigName !== configName) {
      try {
        await sm.send(new DeleteEndpointConfigCommand({ EndpointConfigName: oldConfigName }));
        console.log(`Deleted old endpoint config: ${oldConfigName}`);
      } catch (err) {
        console.warn(`Could not delete old endpoint config ${oldConfigName} -- non-fatal: ${err.message}`);
      }
    }
    if (oldModelName && oldModelName !== modelName) {
      try {
        await sm.send(new DeleteModelCommand({ ModelName: oldModelName }));
        console.log(`Deleted old model: ${oldModelName}`);
      } catch (err) {
        console.warn(`Could not delete old model ${oldModelName} -- non-fatal: ${err.message}`);
      }
    }

    return {
      endpointName,
      modelName,
      modelArtifact,
      action: exists ? 'updated' : 'created',
    };
  } catch (err) {
    console.error('sageWorker error:', err);
    throw err;
  }
};
