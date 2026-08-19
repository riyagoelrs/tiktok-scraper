import { desktopCapturer, screen } from 'electron';

/**
 * Grabs the primary screen as a base64 PNG.
 *
 * Some questions are not in the audio at all — the interviewer says "how would
 * you fix this?" over a code editor, and the transcript alone is deaf to it.
 *
 * desktopCapturer's thumbnail is used rather than a media stream: it needs no
 * renderer, no permission prompt beyond the one already granted for loopback
 * audio, and returns a still image directly.
 */
export async function captureScreen(maxWidth = 1280): Promise<string> {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.size;
  const scale = Math.min(1, maxWidth / width);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) },
  });

  const primary = sources[0];
  if (!primary) throw new Error('No screen available to capture');

  const image = primary.thumbnail;
  if (image.isEmpty()) {
    throw new Error('Screen capture came back empty — grant Screen Recording permission');
  }
  return image.toPNG().toString('base64');
}
