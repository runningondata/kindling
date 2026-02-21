export const DEFAULT_CONFIG = {
  skewThreshold: 1.5,
  severeSkewThreshold: 3.0,
  gcPressureThreshold: 0.10,
  stragglerMultiple: 5.0,
  smallTaskDurationMs: 50,
  smallTaskCountMin: 1000,
  executorSkewRatio: 3.0,
  stageTimeDominance: 0.8,
  smallFileAvgSizeWarningMb: 10,
  smallFileAvgSizeCriticalMb: 1,
  smallFileMinCount: 100,
  memoryUtilWarning: 0.90,
  memoryUtilCritical: 0.95,
  longFilterCharThreshold: 500,
  longFilterPredicateThreshold: 10,
  estimationErrorWarning: 100,
  estimationErrorCritical: 1000,
};

export const SEVERITY = {
  CRITICAL: 'critical',
  WARNING: 'warning',
  INFO: 'info',
};

export const ONE_GIB = 1073741824;
