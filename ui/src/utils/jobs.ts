import { JobConfig, JobGpuAssignmentFields, JobGpuSelection, JobWithGpuAssignment } from '@/types';
import type { Job } from '@prisma/client';
import { apiClient } from '@/utils/api';

const normalizeGpuId = (value?: string | null) => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
};

export const getLegacyGpuIdsFromSelection = (trainingGpuId?: string | null, samplingGpuId?: string | null) => {
  const training = normalizeGpuId(trainingGpuId);
  const sampling = normalizeGpuId(samplingGpuId);

  if (!training) {
    return null;
  }

  if (training === 'mps') {
    return 'mps';
  }

  if (sampling && sampling !== training) {
    return `${training},${sampling}`;
  }

  return training;
};

export const splitLegacyGpuIds = (gpuIds?: string | null): JobGpuAssignmentFields => {
  const normalized = normalizeGpuId(gpuIds);
  if (!normalized) {
    return { training_gpu_id: null, sampling_gpu_id: null };
  }

  if (normalized === 'mps') {
    return { training_gpu_id: 'mps', sampling_gpu_id: null };
  }

  const [trainingGpuId, samplingGpuId] = normalized
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  return {
    training_gpu_id: trainingGpuId ?? null,
    sampling_gpu_id: samplingGpuId ?? null,
  };
};

export const resolveJobGpuSelection = (
  job: Partial<JobWithGpuAssignment> & { gpu_ids?: string | null },
): JobGpuSelection => {
  const explicitTraining = normalizeGpuId(job.training_gpu_id);
  const explicitSampling = normalizeGpuId(job.sampling_gpu_id);
  const legacyGpuIds = normalizeGpuId(job.gpu_ids);

  if (explicitTraining || explicitSampling) {
    const trainingGpuId = explicitTraining ?? splitLegacyGpuIds(legacyGpuIds).training_gpu_id;
    const samplingGpuId = trainingGpuId === 'mps' ? null : explicitSampling;

    return {
      training_gpu_id: trainingGpuId,
      sampling_gpu_id: samplingGpuId,
      gpu_ids: getLegacyGpuIdsFromSelection(trainingGpuId, samplingGpuId) ?? legacyGpuIds,
    };
  }

  const legacySelection = splitLegacyGpuIds(legacyGpuIds);
  return {
    ...legacySelection,
    gpu_ids: legacyGpuIds,
  };
};

export const getJobGpuIndexes = (job: Partial<JobWithGpuAssignment> & { gpu_ids?: string | null }) => {
  const selection = resolveJobGpuSelection(job);
  const values = [selection.training_gpu_id, selection.sampling_gpu_id];

  return values
    .filter((value): value is string => !!value && value !== 'mps')
    .map(value => Number(value))
    .filter(value => !Number.isNaN(value));
};

export const formatGpuSelectionLabel = (gpuId: string | null, fallback = 'None') => {
  if (!gpuId) {
    return fallback;
  }

  if (gpuId === 'mps') {
    return 'mps';
  }

  return `GPU #${gpuId}`;
};

export const getJobGpuSummary = (job: Partial<JobWithGpuAssignment> & { gpu_ids?: string | null }) => {
  const selection = resolveJobGpuSelection(job);

  return {
    training: formatGpuSelectionLabel(selection.training_gpu_id, 'Unassigned'),
    sampling: formatGpuSelectionLabel(selection.sampling_gpu_id, 'None'),
    legacy: selection.gpu_ids ?? '—',
  };
};

export const startJob = (jobID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/jobs/${jobID}/start`)
      .then(res => res.data)
      .then(data => {
        console.log('Job started:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error starting job:', error);
        reject(error);
      });
  });
};

export const stopJob = (jobID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/jobs/${jobID}/stop`)
      .then(res => res.data)
      .then(data => {
        console.log('Job stopped:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error stopping job:', error);
        reject(error);
      });
  });
};

export const deleteJob = (jobID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/jobs/${jobID}/delete`)
      .then(res => res.data)
      .then(data => {
        console.log('Job deleted:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error deleting job:', error);
        reject(error);
      });
  });
};

export const markJobAsStopped = (jobID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/jobs/${jobID}/mark_stopped`)
      .then(res => res.data)
      .then(data => {
        console.log('Job marked as stopped:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error marking job as stopped:', error);
        reject(error);
      });
  });
};

export const getJobConfig = (job: Job) => {
  return JSON.parse(job.job_config) as JobConfig;
};

export const getAvaliableJobActions = (job: Job) => {
  const jobConfig = getJobConfig(job);
  const isStopping = job.stop && job.status === 'running';
  const canDelete = ['queued', 'completed', 'stopped', 'error'].includes(job.status) && !isStopping;
  const canEdit = ['queued','completed', 'stopped', 'error'].includes(job.status) && !isStopping;
  const canRemoveFromQueue = job.status === 'queued';
  const canStop = job.status === 'running' && !isStopping;
  let canStart = ['stopped', 'error'].includes(job.status) && !isStopping;
  // can resume if more steps were added
  if (job.status === 'completed' && jobConfig.config.process[0].train.steps > job.step && !isStopping) {
    canStart = true;
  }
  return { canDelete, canEdit, canStop, canStart, canRemoveFromQueue };
};

export const getNumberOfSamples = (job: Job) => {
  const jobConfig = getJobConfig(job);
  return jobConfig.config.process[0].sample?.prompts?.length || 0;
};

export const getTotalSteps = (job: Job) => {
  const jobConfig = getJobConfig(job);
  return jobConfig.config.process[0].train.steps;
};
