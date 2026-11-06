import { giftImageAlt } from "@entrelacos/contracts";
import { Button } from "@entrelacos/ui";
import { useEffect, useId, useRef, useState } from "react";
import {
  acceptedImageTypes,
  fileProblem,
  GiftPhotoAltInput,
  GiftPhotoDropzone,
  photoSecondaryAction,
  photoTextAction,
  useGiftPhotoDrop,
} from "./giftPhotoPicker";

/** A photo chosen for a gift that is not uploaded yet. */
export type PendingGiftPhoto = { file: File | null; alt: string };

type Props = {
  value: PendingGiftPhoto;
  /** 1-based position the gift will take in the catalog list. */
  position: number;
  disabled: boolean;
  /** True while the editor uploads this file. */
  uploading?: boolean;
  /** An upload failure reported by the editor. */
  error?: string;
  onChange: (next: PendingGiftPhoto) => void;
  /** Retries only the upload once the gift has been created. */
  onRetry?: () => void;
};

/**
 * Photo field for a gift that is still being created: the file stays in the
 * browser and the editor uploads it right after the gift is saved.
 */
export function PendingGiftPhotoField({
  value,
  position,
  disabled,
  uploading = false,
  error = "",
  onChange,
  onRetry,
}: Props) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [problem, setProblem] = useState("");
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const { file, alt } = value;
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  function pick(selected: File | null | undefined) {
    if (!selected || disabled) return;
    const reason = fileProblem(selected);
    if (fileInput.current) fileInput.current.value = "";
    if (reason) {
      setProblem(reason);
      return;
    }
    setProblem("");
    onChange({ file: selected, alt });
  }
  function openPicker() {
    if (!disabled) fileInput.current?.click();
  }
  const { dragging, dropHandlers } = useGiftPhotoDrop(disabled, pick);
  const message = problem || error;
  const describedBy = [
    file ? null : `${id}-formats`,
    message ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <fieldset
      aria-labelledby={`${id}-heading`}
      className="m-0 grid min-w-0 gap-4 border-0 p-0"
    >
      <legend id={`${id}-heading`} className="sr-only">
        Foto do presente
      </legend>
      {/* Opened by the visible buttons, so the input stays out of the tab
          order. No `capture`: phones offer both the gallery and the camera. */}
      <input
        ref={fileInput}
        type="file"
        accept={acceptedImageTypes}
        tabIndex={-1}
        disabled={disabled}
        className="sr-only"
        aria-labelledby={`${id}-heading`}
        aria-describedby={describedBy || undefined}
        onChange={(event) => pick(event.target.files?.[0])}
      />
      {!file ? (
        <GiftPhotoDropzone
          formatsId={`${id}-formats`}
          blocked={disabled}
          dragging={dragging}
          dropHandlers={dropHandlers}
          onOpen={openPicker}
        />
      ) : (
        <div className="grid min-w-0 gap-[18px] sm:grid-cols-[minmax(0,1fr)_minmax(0,262px)]">
          <div
            data-dragging={dragging ? "true" : "false"}
            {...dropHandlers}
            className={`relative flex min-h-[212px] min-w-0 items-center justify-center overflow-hidden rounded-[14px] bg-admin-beige-deep ${dragging ? "outline-[3px] outline-offset-2 outline-admin-terracotta outline-dashed" : ""}`}
          >
            {localUrl && (
              <img
                src={localUrl}
                alt={giftImageAlt(alt, position)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            )}
            <span
              aria-live="polite"
              className={`absolute bottom-3 left-3 max-w-[calc(100%-24px)] truncate rounded-full px-2.5 py-1 text-xs font-bold ${uploading ? "bg-admin-pending-wash text-admin-pending-ink" : "bg-admin-success-wash text-admin-success-ink"}`}
            >
              {uploading ? "Enviando foto…" : `Foto escolhida · ${file.name}`}
            </span>
          </div>
          <div className="flex min-w-0 flex-col justify-between gap-4">
            <GiftPhotoAltInput
              id={id}
              value={alt}
              disabled={disabled}
              onChange={(next) => {
                if (!disabled) onChange({ file, alt: next });
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              {onRetry && error && (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={disabled}
                  onClick={onRetry}
                >
                  Enviar foto de novo
                </Button>
              )}
              <button
                type="button"
                disabled={disabled}
                className={photoSecondaryAction}
                onClick={openPicker}
              >
                Trocar foto
              </button>
              <button
                type="button"
                aria-label="Remover foto escolhida"
                disabled={disabled}
                className={photoTextAction}
                onClick={() => {
                  setProblem("");
                  onChange({ file: null, alt: "" });
                }}
              >
                Remover
              </button>
            </div>
          </div>
        </div>
      )}
      {message && (
        <p
          id={`${id}-error`}
          role="alert"
          className="m-0 text-sm text-admin-danger-ink"
        >
          {message}
        </p>
      )}
    </fieldset>
  );
}
