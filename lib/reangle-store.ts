import { prisma } from './db';
import { getBucketConfig } from './aws-config';
import { uploadRemoteToS3 } from './s3-upload';
import { wavespeedSubmit, wavespeedWait, wavespeedResult } from './wavespeed';
import { heartbeatJob, isCancelRequested } from './jobs';
import { TerminalReangleError, obtainReangle, type ReangleCache, type ReangleRequest } from './reangle';

export async function readReangleCache(request: ReangleRequest): Promise<ReangleCache | null> {
  const row = await prisma.generationJob.findUnique({ where: { id: request.cacheId }, select: { resultData: true } });
  if (!row?.resultData) return null;
  return JSON.parse(row.resultData) as ReangleCache;
}
/** Internal cache, never a user-facing still stage. Unique deterministic job PK is the submission lock. */
export async function ensureReangle(request: ReangleRequest, context: { jobId: string; sceneId: string; projectId: string }) {
  const { folderPrefix } = getBucketConfig();
  return obtainReangle(request, {
    read: () => readReangleCache(request),
    claim: async failed => {
      if (failed?.phase === 'failed') {
        const changed = await prisma.generationJob.updateMany({ where: { id: request.cacheId, resultData: JSON.stringify(failed) },
          data: { status: 'processing', resultData: JSON.stringify({ phase: 'claimed' }) } });
        return changed.count === 1;
      }
      try {
        await prisma.generationJob.create({ data: {
          id: request.cacheId, type: 'camera-reangle-cache', status: 'processing', projectId: context.projectId,
          sceneId: context.sceneId, message: 'Preparing a new camera view from the previous video',
          resultData: JSON.stringify({ phase: 'claimed' }),
        } });
        return true;
      } catch (error: any) { if (error?.code === 'P2002') return false; throw error; }
    },
    save: async value => {
      await prisma.generationJob.update({ where: { id: request.cacheId }, data: {
        status: value.phase === 'ready' ? 'completed' : value.phase === 'failed' ? 'failed' : 'processing',
        resultData: JSON.stringify(value), progress: value.phase === 'ready' ? 100 : 10,
      } });
    },
  }, {
    submit: () => wavespeedSubmit(request.slug, request.body, 'Seedream camera re-angle'),
    wait: async id => {
      try {
        return await wavespeedWait(id, { timeoutMs: 240_000, label: 'Seedream camera re-angle',
          shouldCancel: async () => { await heartbeatJob(context.jobId); return isCancelRequested(context.jobId); } });
      } catch (error) {
        const terminal = await wavespeedResult(id, 'Camera re-angle').catch(() => null);
        if (terminal && ['failed', 'canceled'].includes(terminal.status))
          throw new TerminalReangleError('Camera re-angle failed at the image provider. Review the scene camera/references and retry this scene; the video was not submitted.');
        throw new Error('Camera re-angle is not ready. Retry this scene to resume the same image task; no raw-frame fallback was used.');
      }
    },
    upload: url => uploadRemoteToS3(url, `${folderPrefix}public/reangles/${context.projectId}/${request.hash}.png`, 'image/png'),
  });
}
