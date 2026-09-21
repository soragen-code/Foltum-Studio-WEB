"use client";

import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { saveVideoToDevice } from "@/lib/save-video-client";

/**
 * "Download mp4" for a generated clip. On a phone it routes the clip through the native share sheet
 * so the user can tap "Save Video" → the clip lands in the MEDIA LIBRARY (Photos / gallery); on
 * desktop it falls back to a normal file download. See lib/save-video-client.ts.
 */
export function DownloadVideoButton({
  videoUrl,
  fileStem,
  label = "Скачать mp4",
}: {
  videoUrl: string;
  fileStem: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveVideoToDevice(videoUrl, fileStem);
    } catch {
      setError("Не удалось сохранить ролик. Попробуйте ещё раз.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex flex-col">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="inline-flex items-center gap-1 text-sm text-primary disabled:opacity-60"
        data-testid="download-video"
        title="На телефоне откроется меню «Поделиться» — выберите «Сохранить видео», чтобы ролик попал в медиатеку"
      >
        {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} {label}
      </button>
      {error && <span className="mt-1 text-xs text-destructive">{error}</span>}
    </span>
  );
}
