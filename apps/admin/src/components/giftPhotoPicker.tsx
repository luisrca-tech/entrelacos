import { giftMediaUploadInputSchema } from "@entrelacos/contracts";
import { Button, Input } from "@entrelacos/ui";
import { Camera, ImageIcon, Upload } from "lucide-react";
import { type DragEvent, useRef, useState } from "react";

// Shared pieces of the gift photo field: the saved-gift field (GiftImageField)
// and the new-gift field (PendingGiftPhotoField) pick, drop and describe a
// photo the same way.

export const acceptedImageTypes =
  giftMediaUploadInputSchema.shape.contentType.options.join(",");

/** Returns a pt-BR reason when the API would refuse the file, or "" if it fits. */
export function fileProblem(file: File) {
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

export const photoSecondaryAction =
  "inline-flex min-h-11 items-center justify-center rounded-[9px] border border-admin-border-strong bg-transparent px-3.5 text-sm font-semibold text-admin-text focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-admin-accent/30 disabled:cursor-not-allowed disabled:opacity-60 enabled:hover:bg-admin-canvas";
export const photoTextAction =
  "inline-flex min-h-11 items-center bg-transparent px-2 text-sm font-semibold text-admin-accent-hover underline underline-offset-4 focus-visible:outline-[3px] focus-visible:outline-admin-accent/30 disabled:opacity-60";

/** Drag-and-drop handlers that hand the first dropped file to `onFile`. */
export function useGiftPhotoDrop(
  blocked: boolean,
  onFile: (file: File | null | undefined) => void,
) {
  // Child elements fire their own enter/leave events while a file is dragged
  // across the zone, so a depth counter keeps the highlight from flickering.
  const dragDepth = useRef(0);
  const [dragging, setDragging] = useState(false);
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
      onFile(event.dataTransfer?.files?.[0]);
    },
  };
  return { dragging, dropHandlers };
}

/** Empty state: a dropzone with a keyboard-reachable "Escolher foto" button. */
export function GiftPhotoDropzone({
  formatsId,
  blocked,
  dragging,
  dropHandlers,
  onOpen,
}: {
  formatsId: string;
  blocked: boolean;
  dragging: boolean;
  dropHandlers: ReturnType<typeof useGiftPhotoDrop>["dropHandlers"];
  onOpen: () => void;
}) {
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: Pointer convenience only; the "Escolher foto" button inside is the keyboard target.
    <div
      data-dropzone=""
      data-dragging={dragging ? "true" : "false"}
      {...dropHandlers}
      onClick={onOpen}
      className={`flex min-h-[272px] flex-col items-center justify-center gap-2.5 rounded-[14px] border-2 border-dashed px-5 py-8 text-center transition-colors motion-reduce:transition-none has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-admin-accent/30 [@media(max-width:760px)]:min-h-[230px] ${dragging ? "border-admin-accent bg-admin-accent-subtle" : "border-admin-border-strong bg-admin-canvas"} ${blocked ? "cursor-not-allowed opacity-60" : "cursor-pointer"}`}
    >
      <span
        aria-hidden="true"
        className="flex size-14 items-center justify-center rounded-full bg-admin-accent-subtle text-admin-accent-hover"
      >
        <Upload className="size-[26px] [@media(max-width:760px)]:hidden [@media(pointer:coarse)]:hidden" />
        <Camera className="hidden size-[26px] [@media(max-width:760px)]:block [@media(pointer:coarse)]:block" />
      </span>
      <span className="text-base font-bold text-admin-text [@media(max-width:760px)]:hidden [@media(pointer:coarse)]:hidden">
        {dragging ? "Solte a foto para escolher" : "Arraste a foto aqui"}
      </span>
      <span className="hidden text-base font-bold text-admin-text [@media(max-width:760px)]:inline [@media(pointer:coarse)]:inline">
        Tire uma foto ou escolha da galeria
      </span>
      <Button
        type="button"
        variant="outline"
        disabled={blocked}
        className="min-h-11 rounded-[10px] border-admin-border-strong bg-admin-surface px-5 text-[0.95rem] font-semibold text-admin-accent-hover focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-admin-accent/30 [@media(max-width:760px)]:min-h-12 [@media(max-width:760px)]:w-full [@media(max-width:760px)]:max-w-[280px] [@media(pointer:coarse)]:min-h-12"
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
      >
        <ImageIcon aria-hidden="true" />
        Escolher foto
      </Button>
      <span id={formatsId} className="text-[0.82rem] text-admin-text-secondary">
        JPEG, PNG ou WebP · até 5 MB
        <span className="[@media(max-width:760px)]:hidden">
          {" "}
          · fotos na horizontal ficam melhores
        </span>
      </span>
    </div>
  );
}

/** The optional photo description input with its screen-reader hint. */
export function GiftPhotoAltInput({
  id,
  value,
  disabled,
  onChange,
}: {
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid gap-1.5">
      <label
        htmlFor={`${id}-alt`}
        className="text-sm font-bold text-admin-text"
      >
        Descreva a foto{" "}
        <span className="text-xs font-semibold text-admin-text-secondary">
          · Opcional
        </span>
      </label>
      <Input
        id={`${id}-alt`}
        value={value}
        maxLength={240}
        placeholder="Ex.: Mesa de jantar à luz de velas"
        disabled={disabled}
        aria-describedby={`${id}-alt-hint`}
        className="min-h-[46px] rounded-[10px] border-admin-border-strong bg-admin-surface px-3.5 text-[0.95rem]"
        onChange={(event) => onChange(event.target.value)}
      />
      <p
        id={`${id}-alt-hint`}
        className="m-0 text-[0.8rem] leading-[1.45] text-admin-text-secondary"
      >
        Ajuda quem usa leitor de tela.
      </p>
    </div>
  );
}
