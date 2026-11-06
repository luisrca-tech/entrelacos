import {
  type GiftItem,
  type GiftMediaPublicAsset,
  giftImageAlt,
} from "@entrelacos/contracts";
import { Button, Input, toast } from "@entrelacos/ui";
import { ImageIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { GiftMediaClientState } from "./giftMediaClient";
import {
  acceptedImageTypes,
  fileProblem,
  GiftPhotoAltInput,
  GiftPhotoDropzone,
  photoSecondaryAction as secondaryAction,
  photoTextAction as textAction,
  useGiftPhotoDrop,
} from "./giftPhotoPicker";

type Props = {
  gift: GiftItem;
  /** 1-based position of the gift in the list it is shown in. */
  position: number;
  disabled: boolean;
  preview?: GiftMediaPublicAsset;
  mediaState?: GiftMediaClientState;
  isCurrent?: () => boolean;
  onUpload: (file: File, alt: string) => Promise<void>;
  onRemove: () => Promise<void>;
  onAltChange: (alt: string) => Promise<void>;
  onConsult?: () => Promise<void>;
  onRecover?: (alt: string) => Promise<void>;
};
export function GiftImageField(props: Props) {
  const { gift, position, disabled, preview, mediaState } = props;
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const live = useRef(props);
  live.current = props;
  const mounted = useRef(false);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState(gift.altText);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!file || typeof URL.createObjectURL !== "function") {
      setLocalUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setLocalUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const scope = JSON.stringify([
    gift.siteId,
    gift.id,
    gift.mediaAssetId,
    gift.altText,
  ]);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      attempt.current++;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: A changed selected gift or eligibility owns a new field instance.
  useLayoutEffect(() => {
    attempt.current++;
    inFlight.current = false;
    setFile(null);
    setAlt(gift.altText);
    setError("");
    setBusy(false);
    if (fileInput.current) fileInput.current.value = "";
  }, [scope, disabled]);
  function validOwner() {
    try {
      return live.current.isCurrent?.() !== false;
    } catch {
      return false;
    }
  }
  function current(revision: number) {
    const value = live.current;
    return (
      mounted.current &&
      revision === attempt.current &&
      !value.disabled &&
      JSON.stringify([
        value.gift.siteId,
        value.gift.id,
        value.gift.mediaAssetId,
        value.gift.altText,
      ]) === scope &&
      validOwner() &&
      revision === attempt.current
    );
  }
  const blocked = disabled || busy || Boolean(mediaState?.busy);
  function pick(selected: File | null | undefined) {
    if (!selected || blocked || inFlight.current || !validOwner()) return;
    const problem = fileProblem(selected);
    if (problem) {
      setError(problem);
      if (fileInput.current) fileInput.current.value = "";
      return;
    }
    setError("");
    setFile(selected);
  }
  function openPicker() {
    if (!blocked) fileInput.current?.click();
  }
  const { dragging, dropHandlers } = useGiftPhotoDrop(blocked, pick);
  async function run(action: (revision: number) => Promise<void>) {
    if (disabled || inFlight.current || mediaState?.busy || !validOwner())
      return;
    const revision = ++attempt.current;
    if (!current(revision)) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!current(revision)) return;
      await action(revision);
    } catch {
      if (current(revision))
        toast.error(
          "Não foi possível atualizar a imagem. Consulte o envio antes de tentar novamente.",
        );
    } finally {
      if (current(revision)) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  function upload() {
    const selected = file;
    const description = alt.trim();
    if (!selected || description.length > 240 || fileProblem(selected)) {
      if (validOwner())
        setError("Escolha uma imagem JPEG, PNG ou WebP de até 5 MB.");
      return;
    }
    if (mediaState?.retained && !mediaState.canRetrySameBytes) return;
    const action = live.current.onUpload;
    void run(async (revision) => {
      if (!current(revision)) return;
      await action(selected, description);
      if (!current(revision)) return;
      setFile(null);
      if (fileInput.current) fileInput.current.value = "";
    });
  }
  if (!validOwner())
    return <p role="status">Verifique sua sessão para editar a imagem.</p>;
  const retained = Boolean(mediaState?.retained);
  const retryBlocked = retained && !mediaState?.canRetrySameBytes;
  const phase = mediaState?.state;
  const notice =
    mediaState?.error ||
    (phase === "UNKNOWN"
      ? "O envio ainda não foi confirmado. Consulte ou recupere a imagem."
      : phase === "PROCESSING" || phase === "UPLOADING" || phase === "HASHING"
        ? "A imagem está sendo processada. Aguarde a confirmação."
        : phase === "PENDING"
          ? "Selecione o mesmo arquivo para continuar o envio."
          : phase === "FINALIZED" && retained
            ? "A imagem foi validada. Confirme sua associação ao presente."
            : phase === "FAILED" || phase === "EXPIRED"
              ? "Este envio foi encerrado sem publicação."
              : "");
  const shownPreview =
    preview?.id === gift.mediaAssetId && preview.siteId === gift.siteId
      ? preview
      : null;
  const hasPhoto = Boolean(gift.mediaAssetId) || Boolean(file);
  const altChanged = alt.trim() !== gift.altText.trim();
  const describedBy = [
    hasPhoto ? null : `${id}-formats`,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const uploading = busy || Boolean(mediaState?.busy);
  return (
    <fieldset
      aria-labelledby={`${id}-heading`}
      className="m-0 grid min-w-0 gap-4 border-0 p-0"
    >
      <legend id={`${id}-heading`} className="sr-only">
        Foto do presente
      </legend>
      {/* The picker is opened by the visible buttons, so the input stays out
          of the tab order. No `capture` attribute: phones then offer both the
          gallery and the camera. */}
      <input
        ref={fileInput}
        id={`${id}-file`}
        type="file"
        accept={acceptedImageTypes}
        tabIndex={-1}
        disabled={blocked}
        className="sr-only"
        aria-labelledby={`${id}-heading`}
        aria-describedby={describedBy || undefined}
        onChange={(event) => pick(event.target.files?.[0])}
      />
      {!hasPhoto ? (
        <GiftPhotoDropzone
          formatsId={`${id}-formats`}
          blocked={blocked}
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
            {localUrl ? (
              <img
                src={localUrl}
                alt=""
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : shownPreview ? (
              <img
                src={shownPreview.url}
                alt={giftImageAlt(gift.altText, position)}
                className="absolute inset-0 h-full w-full object-cover"
              />
            ) : (
              <ImageIcon
                aria-hidden="true"
                className="size-11 text-admin-terracotta-deep"
              />
            )}
            <span
              aria-live="polite"
              className={`absolute bottom-3 left-3 max-w-[calc(100%-24px)] truncate rounded-full px-2.5 py-1 text-xs font-bold ${uploading ? "bg-admin-pending-wash text-admin-pending-ink" : "bg-admin-success-wash text-admin-success-ink"}`}
            >
              {uploading
                ? "Enviando foto…"
                : file
                  ? `Pronta para enviar · ${file.name}`
                  : "Foto enviada"}
            </span>
          </div>
          <div className="flex min-w-0 flex-col justify-between gap-4">
            <GiftPhotoAltInput
              id={id}
              value={alt}
              disabled={blocked}
              onChange={(value) => {
                if (!blocked && !inFlight.current && validOwner())
                  setAlt(value);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              {(file || retained) && (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={blocked || retryBlocked || !file}
                  onClick={upload}
                >
                  {uploading
                    ? "Aguarde…"
                    : retained
                      ? "Reenviar mesmo arquivo"
                      : "Enviar foto"}
                </Button>
              )}
              {gift.mediaAssetId && !file && altChanged && (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={blocked || retained}
                  onClick={() => {
                    const action = live.current.onAltChange;
                    const description = alt.trim();
                    void run(async (revision) => {
                      if (current(revision)) await action(description);
                    });
                  }}
                >
                  Salvar descrição
                </Button>
              )}
              <button
                type="button"
                disabled={blocked}
                className={secondaryAction}
                onClick={openPicker}
              >
                Trocar foto
              </button>
              {file ? (
                <button
                  type="button"
                  aria-label="Remover foto escolhida"
                  disabled={blocked}
                  className={textAction}
                  onClick={() => {
                    setFile(null);
                    setError("");
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  Remover
                </button>
              ) : (
                gift.mediaAssetId && (
                  <button
                    type="button"
                    aria-label="Remover foto"
                    disabled={blocked || retained}
                    className={textAction}
                    onClick={() => {
                      const action = live.current.onRemove;
                      void run(async (revision) => {
                        if (!current(revision)) return;
                        await action();
                        if (current(revision)) setAlt("");
                      });
                    }}
                  >
                    Remover
                  </button>
                )
              )}
            </div>
          </div>
        </div>
      )}
      {notice && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          {notice}
        </p>
      )}
      {retained && (props.onConsult || props.onRecover) && (
        <div className="flex flex-wrap gap-2">
          {props.onConsult && (
            <Button
              type="button"
              variant="outline"
              disabled={blocked}
              onClick={() => {
                const action = live.current.onConsult;
                void run(async (revision) => {
                  if (current(revision)) await action?.();
                });
              }}
            >
              Consultar envio
            </Button>
          )}
          {props.onRecover &&
            (phase === "UNKNOWN" || phase === "FINALIZED") && (
              <Button
                type="button"
                variant="outline"
                disabled={blocked}
                onClick={() => {
                  const action = live.current.onRecover;
                  const description = alt.trim();
                  void run(async (revision) => {
                    if (current(revision)) await action?.(description);
                  });
                }}
              >
                {phase === "FINALIZED"
                  ? "Usar imagem validada"
                  : "Recuperar imagem"}
              </Button>
            )}
        </div>
      )}
      {retained && !hasPhoto && (
        <div className="grid gap-1.5">
          <label
            htmlFor={`${id}-alt`}
            className="text-sm font-bold text-admin-ink"
          >
            Descreva a foto{" "}
            <span className="text-xs font-semibold text-admin-muted">
              · Opcional
            </span>
          </label>
          <Input
            id={`${id}-alt`}
            value={alt}
            maxLength={240}
            disabled={blocked}
            onChange={(event) => {
              if (!blocked && !inFlight.current && validOwner())
                setAlt(event.target.value);
            }}
          />
        </div>
      )}
      {error && (
        <p
          id={`${id}-error`}
          role="alert"
          className="m-0 text-sm text-admin-danger-ink"
        >
          {error}
        </p>
      )}
    </fieldset>
  );
}
