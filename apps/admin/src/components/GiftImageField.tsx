import {
  type GiftItem,
  type GiftMediaPublicAsset,
  giftMediaUploadInputSchema,
} from "@entrelacos/contracts";
import { Button, Input, toast } from "@entrelacos/ui";
import { Camera, ImageIcon, Upload } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { GiftMediaClientState } from "./giftMediaClient";

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
      !giftMediaUploadInputSchema.shape.contentType.safeParse(selected.type)
        .success ||
      !giftMediaUploadInputSchema.shape.byteLength.safeParse(selected.size)
        .success
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
    if (
      !giftMediaUploadInputSchema.shape.contentType.safeParse(selected.type)
        .success ||
      !giftMediaUploadInputSchema.shape.byteLength.safeParse(selected.size)
        .success
    ) {
      setError("Escolha uma imagem JPEG, PNG ou WebP de até 5 MB.");
      return;
    }
    setError("");
    setFile(selected);
  }
  const fileInputElement = (
    <input
      ref={fileInput}
      id={`${id}-file`}
      type="file"
      accept="image/jpeg,image/png,image/webp"
      disabled={blocked}
      className="sr-only"
      aria-describedby={`${id}-formats`}
      onChange={(event) => {
        if (!blocked && !inFlight.current && validOwner())
          setFile(event.target.files?.[0] ?? null);
      }}
    />
  );
  return (
    <fieldset
      aria-labelledby={`${id}-heading`}
      className="m-0 grid min-w-0 gap-4 border-0 p-0"
    >
      <legend id={`${id}-heading`} className="sr-only">
        Foto do presente
      </legend>
      {!hasPhoto ? (
        <label
          htmlFor={`${id}-file`}
          onDragOver={(event) => {
            event.preventDefault();
            if (!blocked) setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            pick(event.dataTransfer.files?.[0]);
          }}
          className={`flex min-h-[272px] cursor-pointer flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed px-5 py-8 text-center transition-colors motion-reduce:transition-none has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[rgb(168_77_57_/_30%)] [@media(max-width:760px)]:min-h-[230px] ${dragging ? "border-admin-terracotta bg-admin-terracotta-wash" : "border-admin-line-strong bg-admin-canvas"} ${blocked ? "cursor-not-allowed opacity-60" : ""}`}
        >
          {fileInputElement}
          <span
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-full bg-admin-terracotta-wash text-admin-terracotta-deep"
          >
            <Upload className="size-[26px] [@media(max-width:760px)]:hidden" />
            <Camera className="hidden size-[26px] [@media(max-width:760px)]:block" />
          </span>
          <span className="text-base font-bold text-admin-ink [@media(max-width:760px)]:hidden">
            Arraste a foto aqui ou{" "}
            <span className="text-admin-terracotta-deep underline underline-offset-4">
              escolha um arquivo
            </span>
          </span>
          <span className="hidden text-base font-bold text-admin-ink [@media(max-width:760px)]:inline">
            Tirar foto ou escolher da galeria
          </span>
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
        </label>
      ) : (
        <div className="grid min-w-0 gap-[18px] sm:grid-cols-[minmax(0,1fr)_minmax(0,262px)]">
          <div className="relative flex min-h-[212px] min-w-0 items-center justify-center overflow-hidden rounded-[14px] bg-admin-beige-deep">
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
            <span className="absolute bottom-3 left-3 max-w-[calc(100%-24px)] truncate rounded-full bg-admin-success-wash px-2.5 py-1 text-xs font-bold text-admin-success-ink">
              {file ? `Pronta para enviar · ${file.name}` : "Foto enviada"}
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
                  disabled={blocked || retryBlocked || !file || !alt.trim()}
                  onClick={upload}
                >
                  {busy || mediaState?.busy
                    ? "Aguarde…"
                    : retained
                      ? "Reenviar mesmo arquivo"
                      : "Enviar foto"}
                </Button>
              )}
              {gift.mediaAssetId && !file && altChanged && (
                <Button
                  type="button"
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
              <label
                htmlFor={`${id}-file`}
                className={`inline-flex min-h-10 cursor-pointer items-center rounded-[9px] border border-admin-line-strong px-3.5 text-sm font-semibold text-admin-graphite has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-[rgb(168_77_57_/_30%)] ${blocked ? "cursor-not-allowed opacity-60" : "hover:bg-admin-canvas"}`}
              >
                {fileInputElement}
                Trocar foto
              </label>
              {file ? (
                <button
                  type="button"
                  disabled={blocked}
                  className="inline-flex min-h-10 items-center bg-transparent px-2 text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4 disabled:opacity-60"
                  onClick={() => {
                    setFile(null);
                    if (fileInput.current) fileInput.current.value = "";
                  }}
                >
                  Cancelar escolha
                </button>
              ) : (
                gift.mediaAssetId && (
                  <button
                    type="button"
                    aria-label="Remover foto"
                    disabled={blocked || retained}
                    className="inline-flex min-h-10 items-center bg-transparent px-2 text-sm font-semibold text-admin-terracotta-deep underline underline-offset-4 disabled:opacity-60"
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
        <p role="alert" className="m-0 text-sm text-admin-danger-ink">
          {error}
        </p>
      )}
    </fieldset>
  );
}
