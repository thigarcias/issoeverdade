import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createMediaFixture(t, { durationSec = 2, video = true, audio = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "iev media fixture-"));
  const file = join(dir, video ? "fixture.mp4" : "fixture.mp3");
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (video) args.push("-f", "lavfi", "-i", `testsrc2=size=320x180:rate=15:duration=${durationSec}`);
  if (audio) args.push("-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`);
  if (video && audio) args.push("-map", "0:v:0", "-map", "1:a:0", "-c:v", "mpeg4", "-q:v", "5", "-c:a", "aac");
  else if (video) args.push("-map", "0:v:0", "-c:v", "mpeg4", "-q:v", "5");
  else args.push("-map", "0:a:0", "-c:a", "libmp3lame", "-q:a", "6");
  args.push("-t", String(durationSec));
  if (video) args.push("-movflags", "+faststart");
  args.push(file);
  try {
    await execFileAsync("ffmpeg", args, { timeout: 30_000, windowsHide: true });
    const bytes = await readFile(file);
    if (!bytes.length) throw new Error("ffmpeg produced an empty media fixture");
    return {
      dir,
      file,
      bytes,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    if (error?.code === "ENOENT") {
      t.skip("ffmpeg is required for real-media integration fixtures");
      return null;
    }
    throw error;
  }
}
