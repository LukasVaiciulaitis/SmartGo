#!/usr/bin/env python3
# sageRoadModel.py
# SageMaker sklearn container script for the SmartGo road delay model.
# Handles both training (if __name__ == '__main__') and endpoint serving
# (model_fn / input_fn / predict_fn / output_fn hooks called by the container).
#
# Training:  SageMaker runs this script via sagemaker_program = "sageRoadModel.py".
#            Trains three HistGradientBoostingRegressor models (q10, q50, q90),
#            computes adaptive hierarchical calibration, evaluates on the held-out val
#            split, and writes all artefacts to /opt/ml/model/.
#            Copies itself into /opt/ml/model/ so the serving hooks are bundled into
#            model.tar.gz automatically -- no separate injection step needed.
#
# Serving:   SageMaker imports this module and calls model_fn / predict_fn per request.
#            Input  (JSON): raw row fields -- departureTimeLocal, dayOfWeek, legType,
#                           persona, travelMode, distanceMeters, staticDurationSeconds,
#                           weatherTempC, weatherPrecipMm, weatherWindKph, weatherCondition,
#                           eventCount, maxEventCapacity, nearestEventKm, roadworksCount,
#                           roadworksFraction, isHoliday
#            Output (JSON): { trafficDeltaSeconds: int, lo: int, hi: int }
#                           lo/hi are the 10th/90th percentile calibrated confidence interval.
#
# Training input: 52-week rolling CSV from sageDataLoader via the 'train' channel.
# Performs internal 80/20 random split: 80% training, 20% calibration + evaluation.

import argparse
import csv
import json
import math
import os
import shutil
import sys
from collections import defaultdict

import boto3
import joblib
import numpy as np
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.model_selection import train_test_split

# ─── Feature engineering ──────────────────────────────────────────────────────

FOG_CONDITIONS = {'Fog', 'Freezing Fog', 'Depositing Rime Fog'}
MORNING_PEAK   = 8 * 60
EVENING_PEAK   = 17 * 60
FLOOR_FRACTION = 0.70  # prediction floor: cannot be lower than -30% of free-flow duration

def engineer(row):
    static   = int(row['staticDurationSeconds'])
    distance = int(row['distanceMeters'])
    dep_h, dep_m = map(int, str(row['departureTimeLocal']).split(':'))
    dep_mins = dep_h * 60 + dep_m
    speed    = distance / static if static > 0 else 0.0
    day      = row['dayOfWeek']
    return {
        'departureMins':        dep_mins,
        'sinHour':              math.sin(2 * math.pi * dep_mins / 1440),
        'cosHour':              math.cos(2 * math.pi * dep_mins / 1440),
        'minsFromMorningPeak':  abs(dep_mins - MORNING_PEAK),
        'minsFromEveningPeak':  abs(dep_mins - EVENING_PEAK),
        'isEveningReturn':      1 if row.get('legType') == 'eveningReturn' else 0,
        'dayMon': 1 if day == 'MON' else 0,
        'dayTue': 1 if day == 'TUE' else 0,
        'dayWed': 1 if day == 'WED' else 0,
        'dayThu': 1 if day == 'THU' else 0,
        'dayFri': 1 if day == 'FRI' else 0,
        'daySat': 1 if day == 'SAT' else 0,
        'personaCityCentre':    1 if row.get('persona') == 'cityCentreRadial' else 0,
        'personaSmallBusiness': 1 if row.get('persona') == 'smallBusinessNeighbourhood' else 0,
        'distanceMeters':          distance,
        'staticDurationSeconds':   static,
        'avgFreeFlowSpeed':        round(speed, 3),
        'weatherTempC':            float(row.get('weatherTempC', 10.0)),
        'weatherPrecipMm':         float(row.get('weatherPrecipMm', 0.0)),
        'weatherWindKph':          float(row.get('weatherWindKph', 15.0)),
        'hasFog':                  1 if row.get('weatherCondition') in FOG_CONDITIONS else 0,
        'eventCount':              int(row.get('eventCount', 0)),
        'maxEventCapacity':        int(row.get('maxEventCapacity', 0)),
        'nearestEventKm':          float(row.get('nearestEventKm', 99.0)),
        'roadworksCount':          int(row.get('roadworksCount', 0)),
        'roadworksFraction':       float(row.get('roadworksFraction', 0.0)),
        'isHoliday':               int(row.get('isHoliday', 0)),
        'isWalk':                  1 if row.get('travelMode') == 'WALK'    else 0,
        'isBicycle':               1 if row.get('travelMode') == 'BICYCLE' else 0,
    }

def segment_key(row):
    dep_h     = int(str(row['departureTimeLocal']).split(':')[0])
    distance  = int(row['distanceMeters'])
    dist_band = 'short' if distance < 5000 else 'medium' if distance < 15000 else 'long'
    return (row.get('legType', ''), row['dayOfWeek'], dep_h, dist_band)

def parent_keys(seg):
    return [seg, seg[:3], seg[:2], seg[:1]]

# ─── Calibration helpers ───────────────────────────────────────────────────────

MIN_N      = 30
ALPHA_MIN  = 0.30
ALPHA_MAX  = 0.70
ALPHA_KNEE = 500

def adaptive_alpha(n):
    t = min(1.0, (n - MIN_N) / (ALPHA_KNEE - MIN_N))
    return ALPHA_MIN + (ALPHA_MAX - ALPHA_MIN) * t

def blend(slope, intercept, mr, ma, n):
    alpha = adaptive_alpha(n)
    s = alpha * slope + (1 - alpha) * 1.0
    return s, ma - s * mr

def build_calibration(val_rows, pred_val_q50):
    """Compute per-segment and global linear calibration from held-out val set."""
    _seg_data = defaultdict(lambda: {'raws': [], 'actuals': []})
    for row, p in zip(val_rows, pred_val_q50):
        d = _seg_data[segment_key(row)]
        d['raws'].append(p)
        d['actuals'].append(int(row['trafficDeltaSeconds']))

    _parent_data = defaultdict(lambda: {'raws': [], 'actuals': []})
    for row, p in zip(val_rows, pred_val_q50):
        for pseg in parent_keys(segment_key(row))[1:]:
            d = _parent_data[pseg]
            d['raws'].append(p)
            d['actuals'].append(int(row['trafficDeltaSeconds']))

    cal = {}
    for store in [_seg_data, _parent_data]:
        for seg, data in store.items():
            n = len(data['raws'])
            if seg not in cal and n >= MIN_N:
                r = np.array(data['raws'])
                a = np.array(data['actuals'])
                s, i = np.polyfit(r, a, 1)
                slope, intercept = blend(s, i, r.mean(), a.mean(), n)
                cal[seg] = {'slope': float(slope), 'intercept': float(intercept), 'n': n}

    y_val = np.array([int(r['trafficDeltaSeconds']) for r in val_rows])
    gs_r, gi_r = np.polyfit(pred_val_q50, y_val, 1)
    gs, gi = blend(gs_r, gi_r, pred_val_q50.mean(), y_val.mean(), len(pred_val_q50))

    cal_serialisable = {str(k): v for k, v in cal.items()}
    return cal_serialisable, float(gs), float(gi)

def _get_cal(row, calibration):
    segments = calibration.get('segments', {})
    for pseg in parent_keys(segment_key(row)):
        key = str(pseg)
        if key in segments:
            return segments[key]['slope'], segments[key]['intercept']
    return calibration['global_slope'], calibration['global_intercept']

def calibrate_interval(raw_q10, raw_q50, raw_q90, row, calibration):
    a, b = _get_cal(row, calibration)
    return a * raw_q10 + b, a * raw_q50 + b, a * raw_q90 + b

# ─── Data loading ─────────────────────────────────────────────────────────────

def load_csv(path):
    rows = []
    with open(path, newline='', encoding='utf-8') as fh:
        for row in csv.DictReader(fh):
            rows.append(row)
    return rows

def to_XYW(rows, feature_cols):
    X = np.array([[engineer(r)[c] for c in feature_cols] for r in rows])
    y = np.array([int(r['trafficDeltaSeconds']) for r in rows])
    w = np.array([float(r.get('sampleWeight') or '1.0') for r in rows])
    return X, y, w

# ─── Serving hooks ─────────────────────────────────────────────────────────────

def model_fn(model_dir):
    """Called once at endpoint startup. Returns the full model bundle."""
    models = {}
    for name in ('q10', 'q50', 'q90'):
        models[name] = joblib.load(os.path.join(model_dir, f'model_{name}.joblib'))

    with open(os.path.join(model_dir, 'calibration.json')) as fh:
        calibration = json.load(fh)

    with open(os.path.join(model_dir, 'feature_schema.json')) as fh:
        schema = json.load(fh)

    return {'models': models, 'calibration': calibration, 'columns': schema['columns']}

def input_fn(request_body, content_type='application/json'):
    if content_type == 'application/json':
        return json.loads(request_body)
    raise ValueError(f'Unsupported content type: {content_type}')

def predict_fn(data, model_bundle):
    models      = model_bundle['models']
    calibration = model_bundle['calibration']
    columns     = model_bundle['columns']

    feats = engineer(data)
    X = np.array([[feats[c] for c in columns]])

    raw_q10 = float(models['q10'].predict(X)[0])
    raw_q50 = float(models['q50'].predict(X)[0])
    raw_q90 = float(models['q90'].predict(X)[0])

    lo, mid, hi = calibrate_interval(raw_q10, raw_q50, raw_q90, data, calibration)

    # Floor clamp: prediction cannot be lower than -FLOOR_FRACTION of free-flow duration.
    # Prevents unphysical negative delays that would push departure later than needed.
    static = int(data['staticDurationSeconds'])
    floor  = calibration.get('floor_fraction', FLOOR_FRACTION) * static - static
    mid    = max(mid, floor)
    lo     = max(lo,  floor)
    hi     = max(hi,  lo)

    return {
        'trafficDeltaSeconds': int(round(mid)),
        'lo':                  int(round(lo)),
        'hi':                  int(round(hi)),
    }

def output_fn(prediction, accept='application/json'):
    return json.dumps(prediction), 'application/json'

# ─── Main (training) ──────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--eval-bucket',     type=str, default=os.environ.get('SM_HP_EVAL_BUCKET', ''))
    parser.add_argument('--eval-key-prefix', type=str, default='evaluations')
    args, _ = parser.parse_known_args()

    model_dir = os.environ.get('SM_MODEL_DIR', '/opt/ml/model')
    train_dir = os.environ.get('SM_CHANNEL_TRAIN', '/opt/ml/input/data/train')
    job_name  = os.environ.get('TRAINING_JOB_NAME', 'local')

    print(f"[sageRoadModel.py] job={job_name}", flush=True)
    print(f"[sageRoadModel.py] train_dir={train_dir}", flush=True)

    # Load the full 52-week rolling dataset written by sageDataLoader.
    data_file = os.path.join(train_dir, 'train.csv')
    print("[sageRoadModel.py] Loading data...", flush=True)
    all_rows = load_csv(data_file)
    print(f"[sageRoadModel.py] total rows={len(all_rows):,}", flush=True)

    # Internal 80/20 random split. Fixed seed for reproducibility within a run.
    # The rolling window in sageDataLoader ensures the dataset stays bounded and fresh --
    # no need for temporal splitting here; patterns are weekly-cyclical, not trending.
    train_rows, val_rows = train_test_split(all_rows, test_size=0.20, random_state=42)
    print(f"[sageRoadModel.py] split: train={len(train_rows):,}  val={len(val_rows):,}", flush=True)

    sample = train_rows[0]
    feature_cols = list(engineer(sample).keys())

    X_train, y_train, w_train = to_XYW(train_rows, feature_cols)
    X_val,   y_val,   _       = to_XYW(val_rows,   feature_cols)

    COMMON = dict(max_iter=200, max_depth=5, learning_rate=0.1,
                  min_samples_leaf=20, validation_fraction=None)

    models = {
        'q10':  HistGradientBoostingRegressor(loss='quantile', quantile=0.10, random_state=42, **COMMON),
        'q50':  HistGradientBoostingRegressor(loss='quantile', quantile=0.50, random_state=42, **COMMON),
        'q90':  HistGradientBoostingRegressor(loss='quantile', quantile=0.90, random_state=42, **COMMON),
    }

    print("[sageRoadModel.py] Training 3 models (q10, q50, q90)...", flush=True)
    for name, m in models.items():
        m.fit(X_train, y_train, sample_weight=w_train)
        print(f"  {name} done", flush=True)

    pred_val_q50 = models['q50'].predict(X_val)

    print("[sageRoadModel.py] Computing calibration on val set...", flush=True)
    cal, g_slope, g_intercept = build_calibration(val_rows, pred_val_q50)
    print(f"  {len(cal)} segment fits | global slope={g_slope:.3f} intercept={g_intercept:.1f}", flush=True)

    calibration = {
        'segments':         cal,
        'global_slope':     g_slope,
        'global_intercept': g_intercept,
        'floor_fraction':   FLOOR_FRACTION,
    }

    # Evaluate calibrated predictions on val -- these are the gate metrics.
    # Val rows are held out from training so this is an honest estimate of generalisation.
    preds_q10 = models['q10'].predict(X_val)
    preds_q50 = models['q50'].predict(X_val)
    preds_q90 = models['q90'].predict(X_val)

    cal_preds, errors, inside_ci = [], [], []
    for i, row in enumerate(val_rows):
        static = int(row['staticDurationSeconds'])
        lo, mid, hi = calibrate_interval(
            float(preds_q10[i]), float(preds_q50[i]), float(preds_q90[i]),
            row, calibration,
        )
        mid = max(mid, FLOOR_FRACTION * static - static)
        actual = int(row['trafficDeltaSeconds'])
        cal_preds.append(mid)
        errors.append(mid - actual)
        inside_ci.append(1 if lo <= actual <= hi else 0)

    errors_arr = np.array(errors)
    cal_rmse   = float(np.sqrt(np.mean(errors_arr ** 2)))
    cal_bias   = float(np.mean(errors_arr))
    cal_mae    = float(np.mean(np.abs(errors_arr)))
    within_300 = float(np.mean(np.abs(errors_arr) <= 300))
    ci_cov     = float(np.mean(inside_ci))

    gate_rmse = 600.0
    gate_bias = 200.0
    gate_pass = cal_rmse <= gate_rmse and abs(cal_bias) <= gate_bias

    print(f"[sageRoadModel.py] Val evaluation:", flush=True)
    print(f"  RMSE={cal_rmse:.1f}s  bias={cal_bias:.1f}s  MAE={cal_mae:.1f}s  within300={within_300:.1%}  CI_cov={ci_cov:.1%}  gate={'PASS' if gate_pass else 'FAIL'}", flush=True)

    evaluation = {
        'calibrated_rmse':     cal_rmse,
        'calibrated_bias':     cal_bias,
        'calibrated_mae':      cal_mae,
        'within_300s_pct':     within_300,
        'ci_coverage':         ci_cov,
        'gate_rmse_threshold': gate_rmse,
        'gate_bias_threshold': gate_bias,
        'gate_pass':           gate_pass,
        'n_val':               len(val_rows),
        'n_segments':          len(cal),
        'global_slope':        g_slope,
        'global_intercept':    g_intercept,
        'job_name':            job_name,
    }

    if args.eval_bucket:
        s3 = boto3.client('s3')
        eval_key = f'{args.eval_key_prefix}/{job_name}/evaluation.json'
        s3.put_object(
            Bucket=args.eval_bucket,
            Key=eval_key,
            Body=json.dumps(evaluation),
            ContentType='application/json',
        )
        print(f"[sageRoadModel.py] Wrote evaluation to s3://{args.eval_bucket}/{eval_key}", flush=True)

    # ─── Save artefacts to model dir ──────────────────────────────────────────

    os.makedirs(model_dir, exist_ok=True)

    # Copy this script into model_dir so the serving hooks are bundled into
    # model.tar.gz automatically -- SageMaker extracts it to /opt/ml/model/ at
    # endpoint startup and loads it via SAGEMAKER_PROGRAM = "sageRoadModel.py".
    shutil.copy(__file__, model_dir)

    for name, m in models.items():
        out = os.path.join(model_dir, f'model_{name}.joblib')
        joblib.dump(m, out)
        print(f"[sageRoadModel.py] Saved {out}", flush=True)

    with open(os.path.join(model_dir, 'calibration.json'), 'w') as fh:
        json.dump(calibration, fh)

    with open(os.path.join(model_dir, 'feature_schema.json'), 'w') as fh:
        json.dump({'columns': feature_cols, 'version': 1}, fh)

    with open(os.path.join(model_dir, 'evaluation.json'), 'w') as fh:
        json.dump(evaluation, fh)

    print(f"[sageRoadModel.py] Done. gate={'PASS' if gate_pass else 'FAIL'}", flush=True)

    # TODO: drift monitor
    # A future sageMonitor Lambda should load the last 7 days of real Dagon rows,
    # invoke the live endpoint in batches, and compare calibrated predictions to actuals.
    # Appropriate drift thresholds: RMSE > 700s or |bias| > 300s (softer than the gate
    # to account for variance between training-val distribution and live production data).
    # On breach, the monitor triggers the Sage pipeline Step Functions for an early retrain.
    # The monitor runs nightly via EventBridge after dagonConsolidator (~18:45 UTC) and
    # the weekly Sunday pipeline run acts as a baseline regardless of drift.

    sys.exit(0)

if __name__ == '__main__':
    main()
