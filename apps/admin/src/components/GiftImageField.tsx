import {
  type GiftItem,
  type GiftMediaPublicAsset,
  giftMediaUploadInputSchema,
} from "@entrelacos/contracts";
import { Button, Input, toast } from "@entrelacos/ui";
import { useId, useLayoutEffect, useRef, useState } from "react";
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

  return (
    <fieldset
      aria-labelledby={`${id}-heading`}
      className="grid min-w-0 gap-4 rounded-2xl border border-admin-line bg-admin-surface p-5"
    >
      <legend id={`${id}-heading`} className="m-0 font-semibold">
        Imagem do presente
      </legend>
      <p className="m-0 text-sm leading-relaxed text-admin-muted">
        Escolha uma foto que represente este presente. JPEG, PNG ou WebP, até 5
        MB.
      </p>
      {preview?.id === gift.mediaAssetId && preview.siteId === gift.siteId ? (
        <img
          src={preview.url}
          alt={gift.altText}
          className="aspect-[16/9] w-full rounded-xl bg-admin-beige/40 object-contain"
        />
      ) : (
        gift.mediaAssetId && (
          <p className="m-0 text-sm text-admin-muted">
            Este presente tem uma imagem cadastrada.
          </p>
        )
      )}
      {notice && (
        <p role="status" className="m-0 text-sm text-admin-muted">
          {notice}
        </p>
      )}
      <label htmlFor={`${id}-file`} className="grid gap-1 text-sm">
        {gift.mediaAssetId ? "Trocar imagem" : "Escolher imagem"}
        <Input
          ref={fileInput}
          id={`${id}-file`}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={blocked}
          onChange={(event) => {
            if (!blocked && !inFlight.current && validOwner())
              setFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      <label htmlFor={`${id}-alt`} className="grid gap-1 text-sm">
        Descrição da imagem
        <span className="font-normal leading-relaxed text-admin-muted">
          Descreva a foto para quem usa leitor de tela.
        </span>
        <Input
          id={`${id}-alt`}
          value={alt}
          maxLength={240}
          placeholder="Ex.: Mesa de jantar à luz de velas"
          disabled={blocked}
          onChange={(event) => {
            if (!blocked && !inFlight.current && validOwner())
              setAlt(event.target.value);
          }}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={blocked || retryBlocked || !file || !alt.trim()}
          onClick={upload}
        >
          {busy || mediaState?.busy
            ? "Aguarde…"
            : retained
              ? "Reenviar mesmo arquivo"
              : "Enviar imagem"}
        </Button>
        {retained && props.onConsult && (
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
        {retained &&
          props.onRecover &&
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
        {gift.mediaAssetId && (
          <>
            <Button
              type="button"
              variant="outline"
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
            <Button
              type="button"
              variant="outline"
              disabled={blocked || retained}
              onClick={() => {
                const action = live.current.onRemove;
                void run(async (revision) => {
                  if (!current(revision)) return;
                  await action();
                  if (current(revision)) setAlt("");
                });
              }}
            >
              Remover imagem
            </Button>
          </>
        )}
      </div>
      {error && (
        <p role="alert" className="m-0 text-sm text-admin-muted">
          {error}
        </p>
      )}
    </fieldset>
  );
}
