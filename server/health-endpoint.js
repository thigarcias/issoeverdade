// Saúde e limites públicos: permite que a interface mostre os mesmos tetos que o
// servidor aplica e que o plantão verifique a configuração sem expor segredos.
import { activeGuard } from "./limits.js";
import { mediaLimits } from "./media.js";
import { moderationConfig } from "./moderation.js";
import { correctionsMode } from "./corrections.js";
import { uploadLimits } from "./uploads.js";
import { PROMPT_VERSION } from "./scoring.js";

export function handleHealthRequest({ env = process.env } = {}) {
  const guard = activeGuard(env);
  const upload = uploadLimits(env);
  const media = mediaLimits(env);
  const moderation = moderationConfig(env);
  return {
    status: 200,
    body: {
      ok: true,
      service: "issoeverdade",
      methodologyVersion: PROMPT_VERSION,
      time: new Date().toISOString(),
      limits: {
        maxUploadBytes: upload.maxFileBytes,
        maxTextChars: upload.maxTextChars,
        maxMediaSeconds: media.maxMediaSeconds,
        maxTransferBytes: media.maxTransferBytes,
      },
      controls: {
        limitsMode: guard.mode,
        rateLimitPerWindow: guard.config.maxPerWindow,
        rateLimitWindowSec: guard.config.windowSec,
        maxConcurrentChecks: guard.config.maxConcurrent,
        dailyCheckUnits: guard.config.dailyUnits,
        moderationMode: moderation.mode,
        videoCoverage: moderation.videoCoverage || "uncovered",
        correctionsMode: correctionsMode(env),
      },
    },
  };
}
