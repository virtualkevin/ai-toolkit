import { apiClient } from '@/utils/api';

const normalizeQueueGpuIds = (queueGpuIds?: string | null) => {
  const trimmed = queueGpuIds?.trim();
  return trimmed ? trimmed : null;
};

export const getQueueTrainingGpuId = (queueGpuIds?: string | null) => {
  const normalized = normalizeQueueGpuIds(queueGpuIds);
  if (!normalized) {
    return null;
  }

  if (normalized === 'mps') {
    return 'mps';
  }

  return normalized.split(',')[0]?.trim() ?? null;
};

export const startQueue = (queueID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/queue/${queueID}/start`)
      .then(res => res.data)
      .then(data => {
        console.log('Queue started:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error starting queue:', error);
        reject(error);
      });
  });
};
export const stopQueue = (queueID: string) => {
  return new Promise<void>((resolve, reject) => {
    apiClient
      .get(`/api/queue/${queueID}/stop`)
      .then(res => res.data)
      .then(data => {
        console.log('Queue stopped:', data);
        resolve();
      })
      .catch(error => {
        console.error('Error stopping queue:', error);
        reject(error);
      });
  });
};
