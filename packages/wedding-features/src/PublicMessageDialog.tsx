import { toast } from "@entrelacos/ui/toaster";
import { useRef, useState } from "react";
import {
  getMessageErrorMessage,
  muralRefreshEventName,
  type WeddingMessagesApi,
} from "./messages";
import { PublicMessageForm } from "./PublicMessageForm";
import {
  SiteDialog,
  siteDialogCloseClass,
  siteDialogEyebrowClass,
  siteDialogHeaderClass,
  siteDialogHeadingClass,
} from "./SiteDialog";

type PublicMessageDialogProps = {
  open: boolean;
  siteId: string;
  api: WeddingMessagesApi | null;
  apiError: string;
  onClose: () => void;
};

export function PublicMessageDialog({
  open,
  siteId,
  api,
  apiError,
  onClose,
}: PublicMessageDialogProps) {
  const [authorName, setAuthorName] = useState("");
  const [messageDraft, setMessageDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef<{ key: string; requestId: string } | null>(null);

  async function publish() {
    if (busy) return;
    if (!api) {
      setError(apiError || "O mural não está disponível agora.");
      return;
    }

    const input = {
      authorName: authorName.trim(),
      text: messageDraft.replace(/\r\n?/g, "\n"),
    };
    const key = JSON.stringify(input);
    const requestId =
      retry.current?.key === key
        ? retry.current.requestId
        : globalThis.crypto.randomUUID();
    retry.current = { key, requestId };
    setBusy(true);
    setError("");

    try {
      await api.createPublicSiteMessage({ requestId, ...input });
      retry.current = null;
      setAuthorName("");
      setMessageDraft("");
      toast.success("Mensagem publicada no mural.");
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(muralRefreshEventName(siteId)));
      }
      onClose();
    } catch (cause) {
      const message = getMessageErrorMessage(cause);
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SiteDialog
      open={open}
      labelledBy="entrelacos-public-message-title"
      onClose={onClose}
    >
      {(requestClose) => (
        <div className="grid gap-6">
          <div className={siteDialogHeaderClass}>
            <div>
              <p className={siteDialogEyebrowClass}>Mural dos convidados</p>
              <h3
                className={siteDialogHeadingClass}
                id="entrelacos-public-message-title"
              >
                Deixe uma mensagem
              </h3>
            </div>
            <button
              type="button"
              className={siteDialogCloseClass}
              data-dialog-initial
              onClick={requestClose}
            >
              Fechar
            </button>
          </div>
          <PublicMessageForm
            authorName={authorName}
            message={messageDraft}
            busy={busy}
            error={error}
            onAuthorNameChange={(value) => {
              setAuthorName(value);
              setError("");
            }}
            onMessageChange={(value) => {
              setMessageDraft(value);
              setError("");
            }}
            onSubmit={() => void publish()}
          />
        </div>
      )}
    </SiteDialog>
  );
}
