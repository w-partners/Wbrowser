// video.js — turn a page's video into something an agent can actually look at.
//
// 🔴 Why this exists: `wb read` can tell you a video is there, but a <video> on X, Reddit
//    or Instagram usually carries a blob: URL — built in the page's memory, not fetchable.
//    Measured 2026-09-27: an agent read an X post, reported the text faithfully, and never
//    mentioned the 41-second video sitting in it, because nothing in the tool could see it.
//    "The tool can't do this" was the wrong lesson; the tool just had no path.
//
// The path has two halves and this file owns the seam:
//   1. Find the real stream. yt-dlp already knows how to do this for X/YouTube/Reddit/etc,
//      so we hand it the PAGE url, not the blob. If yt-dlp does not know the site, we fall
//      back to stream URLs sniffed from the network (collected by the engine).
//   2. Turn it into frames. ffmpeg keyframes — an agent reads JPEGs, it cannot watch mp4.
//
// 🔵 Nothing here touches Chrome. It runs on URLs, so it works on the raw-CDP fallback and
//    never adds a utility world.
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 🔵 Resolve tools at call time, not at import. A missing yt-dlp must be a clear message
//    from the command the user ran, not a stack trace at engine start.
function findBin(name) {
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', name),
    `/usr/local/bin/${name}`,
    `/usr/bin/${name}`,
  ];
  for (const c of candidates) { if (fs.existsSync(c)) return c; }
  return name; // fall back to PATH
}

function run(bin, args, { timeout = 180000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || '').split('\n').filter(Boolean).slice(-4).join(' | ');
        reject(new Error(msg || String(err)));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// 🔴 Do NOT probe with `--version`. ffmpeg's flag is `-version` (one dash) and it exits
//    non-zero on `--version` while still printing the banner — so a probe that trusts the
//    exit code reports "ffmpeg is missing" on a machine where ffmpeg works fine. That is
//    exactly what happened here (2026-09-27): the video downloaded, then the tool told the
//    user to install a tool they already had. A wrong "not installed" sends someone off to
//    fix their machine instead of the code.
//    Existence on disk is the honest question, and it is also cheaper than spawning.
async function have(bin) {
  const resolved = findBin(bin);
  if (resolved.includes('/')) return fs.existsSync(resolved);
  // Not an absolute hit — ask PATH, still without depending on any exit-code convention.
  return (process.env.PATH || '').split(':').some((d) => d && fs.existsSync(path.join(d, bin)));
}

// 🔴 The count is the point. Ten frames of a 40-second clip is a summary; two is a guess.
//    Keep it bounded anyway — every frame is an image the agent has to read.
function frameCount(seconds, max) {
  if (!Number.isFinite(seconds) || seconds <= 0) return Math.min(8, max);
  if (seconds <= 15) return Math.min(8, max);
  if (seconds <= 60) return Math.min(14, max);
  if (seconds <= 300) return Math.min(24, max);
  return Math.min(max, 30);
}

// Pull metadata without downloading: tells us duration up front so the frame plan is honest.
async function probe(pageUrl) {
  const ytdlp = findBin('yt-dlp');
  const { stdout } = await run(ytdlp, [
    '--no-warnings', '--skip-download', '--no-playlist',
    '--print', '%(title)s\t%(duration)s\t%(width)s\t%(height)s\t%(ext)s\t%(uploader)s',
    pageUrl,
  ], { timeout: 120000 });
  const line = stdout.trim().split('\n').filter(Boolean)[0] || '';
  const [title, duration, width, height, ext, uploader] = line.split('\t');
  return {
    title: title || null,
    seconds: duration && duration !== 'NA' ? Number(duration) : null,
    width: width && width !== 'NA' ? Number(width) : null,
    height: height && height !== 'NA' ? Number(height) : null,
    ext: ext || null,
    uploader: uploader && uploader !== 'NA' ? uploader : null,
  };
}

async function download(pageUrl, outDir) {
  const ytdlp = findBin('yt-dlp');
  fs.mkdirSync(outDir, { recursive: true });
  const tmpl = path.join(outDir, 'video.%(ext)s');
  await run(ytdlp, [
    '--no-warnings', '--no-playlist', '--no-progress',
    // 🔵 Cap the height. A 4K download to make 14 thumbnails is pure waste, and on a slow
    //    link it turns a 20-second command into a timeout.
    '-f', 'bv*[height<=720]+ba/b[height<=720]/bv*+ba/b',
    '--merge-output-format', 'mp4',
    '-o', tmpl, pageUrl,
  ], { timeout: 600000 });
  const files = fs.readdirSync(outDir).filter((f) => /^video\./.test(f));
  // prefer the merged mp4
  const pick = files.find((f) => f.endsWith('.mp4')) || files[0];
  if (!pick) throw new Error('yt-dlp finished but no video file was produced');
  return path.join(outDir, pick);
}

// How long is the file, really. yt-dlp's metadata can be absent or wrong for a re-encoded
// merge, and the even-sampling fallback needs a duration to divide by.
async function durationOf(videoPath) {
  try {
    const { stdout } = await run(findBin('ffprobe'), [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
    ], { timeout: 30000 });
    const d = Number(String(stdout).trim());
    return Number.isFinite(d) && d > 0 ? d : null;
  } catch { return null; }
}

async function extractFrames(videoPath, framesDir, wanted) {
  const ffmpeg = findBin('ffmpeg');
  fs.mkdirSync(framesDir, { recursive: true });
  // Keyframes only: fast, and they land on cuts rather than mid-motion blur.
  await run(ffmpeg, [
    '-loglevel', 'error', '-skip_frame', 'nokey', '-i', videoPath,
    '-vsync', '0', '-frame_pts', '1',
    '-vf', 'scale=512:-2',
    '-q:v', '4',
    path.join(framesDir, 'kf_%04d.jpg'),
  ], { timeout: 300000 });
  let frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  // 🔴 A static screen recording can yield 2 keyframes for a 5-minute video. Falling back
  //    to even sampling is not a nicety — without it the agent "looked at the video" and
  //    saw the title card twice.
  if (frames.length < Math.min(4, wanted)) {
    for (const f of frames) fs.unlinkSync(path.join(framesDir, f));
    const secs = await durationOf(videoPath);
    // Spread `wanted` frames across the clip. Without a duration we cannot compute a rate,
    // so fall back to a slow fixed rate rather than guessing a wrong one.
    const fps = secs ? Math.max(wanted / secs, 0.05) : 0.5;
    await run(ffmpeg, [
      '-loglevel', 'error', '-i', videoPath,
      '-vf', `fps=${fps.toFixed(4)},scale=512:-2`,
      '-q:v', '4',
      path.join(framesDir, 'kf_%04d.jpg'),
    ], { timeout: 300000 }).catch(() => {});
    frames = fs.readdirSync(framesDir).filter((f) => f.endsWith('.jpg')).sort();
  }
  // Trim evenly to the wanted count rather than dropping the tail — the end of a clip is
  // often where the payoff is.
  if (frames.length > wanted) {
    const keep = new Set();
    for (let i = 0; i < wanted; i += 1) {
      keep.add(frames[Math.round((i * (frames.length - 1)) / (wanted - 1 || 1))]);
    }
    for (const f of frames) { if (!keep.has(f)) fs.unlinkSync(path.join(framesDir, f)); }
    frames = [...keep].sort();
  }
  return frames.map((f) => path.join(framesDir, f));
}

// The whole job: page URL in, frames on disk out.
async function grab(pageUrl, opts = {}) {
  if (!await have('yt-dlp')) {
    throw new Error('yt-dlp is not installed — it is what knows how to get the real stream '
      + 'behind a blob: URL. Install it (pipx install yt-dlp) and run this again.');
  }
  const outDir = opts.outDir || fs.mkdtempSync(path.join(os.tmpdir(), 'wbvideo-'));
  const meta = await probe(pageUrl);
  const maxFrames = Number(opts.maxFrames) > 0 ? Number(opts.maxFrames) : 30;
  const wanted = frameCount(meta.seconds, maxFrames);

  const result = { ...meta, dir: outDir, frames: [], video: null };
  if (opts.metaOnly) return result;

  result.video = await download(pageUrl, path.join(outDir, 'download'));
  if (!await have('ffmpeg')) {
    result.note = 'Downloaded the video, but ffmpeg is missing so there are no frames to look '
      + 'at. Install ffmpeg to see inside the video.';
    return result;
  }
  result.frames = await extractFrames(result.video, path.join(outDir, 'frames'), wanted);
  return result;
}

module.exports = { grab, probe, frameCount, findBin };
