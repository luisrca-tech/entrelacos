import {
  type GiftItem,
  type GiftMediaPublicAsset,
  giftMediaUploadInputSchema,
} from "@entrelacos/contracts";
import { Button, Input, toast } from "@entrelacos/ui";
import { Camera, ImageIcon, Upload } from "lucide-react";
import {
  type DragEvent,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { GiftMediaClientState } from "./giftMediaClient";

const acceptedImageTypes =
  giftMediaUploadInputSchema.shape.contentType.options.join(",");

/** Returns a pt-BR reason when the API would refuse the file, or "" if it fits. */
function fileProblem(file: File) {
  if (
    !giftMediaUploadInputSchema.shape.contentType.safeParse(file.type).success
  )
    return "Este arquivo não é uma imagem JPEG, PNG ou WebP. Escolha outra foto.";
  if (!giftMediaUploadInputSchema.shape.byteLength.safeParse(file.size).success)
    return file.size > 0
      ? "A foto passa de 5 MB. Escolha uma imagem menor."
      : "Este arquivo está vazio. Escolha outra foto.";
  return "";
}

type Props = {
  gift: GiftItem;
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
  const { gift, disabled, preview, mediaState } = props;
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const live = useRef(props);
  live.current = props;
  const mounted = useRef(false);
  const attempt = useRef(0);
  const inFlight = useRef(false);
  // Child elements fire their own enter/leave events while a file is dragged
  // across the zone, so a depth counter keeps the highlight from flickering.
  const dragDepth = useRef(0);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState(gift.altText);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
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
    if (
      !selected ||
      !description ||
      description.length > 240 ||
      fileProblem(selected)
    ) {
      if (validOwner())
        setError(
          "Escolha uma imagem JPEG, PNG ou WebP de até 5 MB e descreva seu conteúdo.",
        );
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
  const dropHandlers = {
    onDragEnter: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dragDepth.current++;
      if (!blocked) setDragging(true);
    },
    onDragOver: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = blocked ? "none" : "copy";
    },
    onDragLeave: () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (dragDepth.current === 0) setDragging(false);
    },
    onDrop: (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      pick(event.dataTransfer?.files?.[0]);
    },
  };
  const describedBy = [
    hasPhoto ? null : `${id}-formats`,
    error ? `${id}-error` : null,
  ]
    .filter(Boolean)
    .join(" ");
  const uploading = busy || Boolean(mediaState?.busy);
  const secondaryAction =
    "inline-flex min-h-11 items-center justify-center rounded-[9px] border border-admin-line-strong bg-transparent px-3.5 text-sm font-semibold text-admin-graphite focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[rgb(168_77_57_/_30%)] disabled:cursor-not-allowed disabled:opacity-60 enabled:hover:bg-admin-canvas";
  const textAction =
    "inline-flex min-h-11 items-center bg-transparent px-2 text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4 focus-visible:outline-[3px] focus-visible:outline-[rgb(168_77_57_/_30%)] disabled:opacity-60";
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
        // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Pointer convenience only; the "Escolher foto" button inside is the keyboard target.
        <div
          data-dropzone=""
          data-dragging={dragging ? "true" : "false"}
          {...dropHandlers}
          onClick={openPicker}
          className={`flex min-h-[272px] flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed px-5 py-8 text-center transition-colors motion-reduce:transition-none has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[rgb(168_77_57_/_30%)] [@media(max-width:760px)]:min-h-[230px] ${dragging ? "border-admin-terracotta bg-admin-terracotta-wash" : "border-admin-line-strong bg-admin-canvas"} ${blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
        >
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-admin-terracotta-wash text-admin-terracotta-deep"
          >
            <Upload className="size-[26px] [@media(max-width:760px)]:hidden [@media(pointer:coarse)]:hidden" />
            <Camera className="hidden size-[26px] [@media(max-width:760px)]:block [@media(pointer:coarse)]:block" />
          </span>
          <span className="text-base font-bold text-admin-ink [@media(max-width:760px)]:hidden [@media(pointer:coarse)]:hidden">
            {dragging ? "Solte a foto para escolher" : "Arraste a foto aqui"}
          </span>
          <span className="hidden text-base font-bold text-admin-ink [@media(max-width:760px)]:inline [@media(pointer:coarse)]:inline">
            Tire uma foto ou escolha da galeria
          </span>
          <Button
            type="button"
            variant="outline"
            disabled={blocked}
            className="min-h-11 rounded-[10px] border-admin-line-strong bg-admin-surface px-5 text-[0.95rem] font-semibold text-admin-terracotta-deep focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[rgb(168_77_57_/_30%)] [@media(max-width:760px)]:min-h-12 [@media(max-width:760px)]:w-full [@media(max-width:760px)]:max-w-[280px] [@media(pointer:coarse)]:min-h-12"
            onClick={(event) => {
              event.stopPropagation();
              openPicker();
            }}
          >
            <ImageIcon aria-hidden="true" />
            Escolher foto
          </Button>
          <span
            id={`${id}-formats`}
            className="text-[0.82rem] text-admin-muted"
          >
            JPEG, PNG ou WebP · até 5 MB
            <span className="[@media(max-width:760px)]:hidden">
              {" "}
              · fotos na horizontal ficam melhores
            </span>
          </span>
        </div>
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
                alt={gift.altText}
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
            <div className="grid gap-1.5">
              <label
                htmlFor={`${id}-alt`}
                className="text-sm font-bold text-admin-ink"
              >
                Descreva a foto{" "}
                <span className="text-xs font-semibold text-admin-muted">
                  · Obrigatório
                </span>
              </label>
              <Input
                id={`${id}-alt`}
                value={alt}
                maxLength={240}
                placeholder="Ex.: Mesa de jantar à luz de velas"
                disabled={blocked}
                aria-describedby={`${id}-alt-hint`}
                className="min-h-[46px] rounded-[10px] border-admin-line-strong bg-admin-surface px-3.5 text-[0.95rem]"
                onChange={(event) => {
                  if (!blocked && !inFlight.current && validOwner())
                    setAlt(event.target.value);
                }}
              />
              <p
                id={`${id}-alt-hint`}
                className="m-0 text-[0.8rem] leading-[1.45] text-admin-muted"
              >
                Lida em voz alta para quem usa leitor de tela.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(file || retained) && (
                <Button
                  type="button"
                  className="min-h-11"
                  disabled={blocked || retryBlocked || !file || !alt.trim()}
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
                  disabled={blocked || retained || !alt.trim()}
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
                disabled={blocked || !alt.trim()}
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
              · Obrigatório
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
