import { NextResponse } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { isMac } from '@/helpers/basic';
import { buildCompatibleGpuIds, normalizeOptionalGpuId, resolveGpuAssignment } from '@/server/jobGpu';

const prisma = new PrismaClient();

const mapJobResponse = (job: any) => {
  const assignment = resolveGpuAssignment(job);
  return {
    ...job,
    training_gpu_id: assignment.trainingGpuId,
    sampling_gpu_id: assignment.samplingGpuId,
    legacy_gpu_mode: assignment.isLegacyMode && assignment.gpuIds.length > 1,
    queue_key: assignment.queueKey,
  };
};

const resolvePostedGpuAssignment = (body: any) => {
  if (isMac()) {
    return {
      trainingGpuId: 'mps',
      samplingGpuId: null,
      gpuIds: 'mps',
    };
  }

  const explicitTrainingGpuId = normalizeOptionalGpuId(body.training_gpu_id);
  const explicitSamplingGpuId = normalizeOptionalGpuId(body.sampling_gpu_id);

  if (explicitTrainingGpuId) {
    return {
      trainingGpuId: explicitTrainingGpuId,
      samplingGpuId: explicitSamplingGpuId,
      gpuIds: buildCompatibleGpuIds(explicitTrainingGpuId, explicitSamplingGpuId),
    };
  }

  const legacyGpuIds = normalizeOptionalGpuId(body.gpu_ids);
  if (!legacyGpuIds) {
    throw new Error('training_gpu_id or gpu_ids is required');
  }

  const parts = legacyGpuIds
    .split(',')
    .map((piece: string) => piece.trim())
    .filter(Boolean);

  return {
    trainingGpuId: parts[0] ?? null,
    samplingGpuId: parts[1] ?? null,
    gpuIds: legacyGpuIds,
  };
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  try {
    if (id) {
      const job = await prisma.job.findUnique({
        where: { id },
      });
      return NextResponse.json(job ? mapJobResponse(job) : null);
    }

    const jobs = await prisma.job.findMany({
      orderBy: { created_at: 'desc' },
    });
    return NextResponse.json({ jobs: jobs.map(mapJobResponse) });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch training data' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { id, name, job_config } = body;
    const assignment = resolvePostedGpuAssignment(body);

    if (assignment.trainingGpuId && assignment.samplingGpuId && assignment.trainingGpuId === assignment.samplingGpuId) {
      return NextResponse.json({ error: 'Training GPU and sampling GPU must be different' }, { status: 400 });
    }

    if (id) {
      const training = await prisma.job.update({
        where: { id },
        data: {
          name,
          gpu_ids: assignment.gpuIds,
          training_gpu_id: assignment.trainingGpuId,
          sampling_gpu_id: assignment.samplingGpuId,
          job_config: JSON.stringify(job_config),
        },
      });
      return NextResponse.json(mapJobResponse(training));
    }

    const highestQueuePosition = await prisma.job.aggregate({
      _max: {
        queue_position: true,
      },
    });
    const newQueuePosition = (highestQueuePosition._max.queue_position || 0) + 1000;

    const training = await prisma.job.create({
      data: {
        name,
        gpu_ids: assignment.gpuIds,
        training_gpu_id: assignment.trainingGpuId,
        sampling_gpu_id: assignment.samplingGpuId,
        job_config: JSON.stringify(job_config),
        queue_position: newQueuePosition,
      },
    });
    return NextResponse.json(mapJobResponse(training));
  } catch (error: any) {
    if (error.code === 'P2002') {
      return NextResponse.json({ error: 'Job name already exists' }, { status: 409 });
    }
    console.error(error);
    return NextResponse.json({ error: 'Failed to save training data' }, { status: 500 });
  }
}
