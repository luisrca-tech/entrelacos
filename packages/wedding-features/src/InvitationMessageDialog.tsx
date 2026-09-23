import type { InvitationMessageResponse } from "@entrelacos/contracts";
import { toast } from "@entrelacos/ui/toaster";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  clearGuestSession,
  type GuestSessionStorage,
  publishGuestSessionChange,
  readGuestSession,
} from "./guestAccess";
import { InvitationMessageForm } from "./InvitationMessageForm";
import {
  getMessageErrorMessage,
  muralRefreshEventName,
  type WeddingMessagesApi,
  type WeddingMessagesApiError,
} from "./messages";
import {
  SiteDialog,
  siteDialogCloseClass,
  siteDialogEyebrowClass,
  siteDialogHeaderClass,
  siteDialogHeadingClass,
} from "./SiteDialog";

type InvitationMessageDialogProps = {
  open: boolean;
  siteId: string;
  api: WeddingMessagesApi | null;
  apiError: string;
  storage: GuestSessionStorage | null;
  onClose: () => void;
};

export function InvitationMessageDialog({
  open,
  siteId,
  api,
  apiError,
  storage,
  onClose,
}: InvitationMessageDialogProps) {
  const [invitationMessage, setInvitationMessage] =
    useState<InvitationMessageResponse | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const retry = useRef<{ key: string; requestId: string } | null>(null);
  const invitationMessageRef = useRef(invitationMessage);
  invitationMessageRef.current = invitationMessage;

  const loseSession = useCallback(() => {
    if (storage) clearGuestSession(storage, siteId);
    publishGuestSessionChange(siteId);
    onClose();
  }, [onClose, siteId, storage]);

  const reload = useCallback(
    async (preserveDraft: boolean) => {
      const token = storage ? readGuestSession(storage, siteId) : null;
      if (!token || !api) {
        setError(apiError || "A sessão do convite não está disponível.");
        setReady(true);
        return;
      }
      setBusy(true);
      setError("");
      try {
        const current = await api.getInvitationMessage(token);
        setInvitationMessage(current);
        if (!preserveDraft) setMessageDraft(current.message?.text ?? "");
        retry.current = null;
      } catch (cause) {
        const apiFailure = cause as Partial<WeddingMessagesApiError>;
        const message = getMessageErrorMessage(cause);
        setError(message);
        if (apiFailure.status === 401) {
          loseSession();
          toast.error(message);
        } else if (invitationMessageRef.current && !preserveDraft) {
          toast.error(message);
        }
      } finally {
        setReady(true);
        setBusy(false);
      }
    },
    [api, apiError, loseSession, siteId, storage],
  );

  async function save() {
    const token = storage ? readGuestSession(storage, siteId) : null;
    if (!token || !api || !invitationMessage?.canEdit || busy) return;
    const input = {
      expectedRevision: invitationMessage.currentRevision,
      text: messageDraft,
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
      const saved = await api.saveInvitationMessage(token, {
        requestId,
        ...input,
      });
      setInvitationMessage({
        ...invitationMessage,
        currentRevision: saved.message.revision,
        message: saved.message,
      });
      setMessageDraft(saved.message.text);
      retry.current = null;
      toast.success(
        saved.result === "NO_CHANGE"
          ? "A mensagem já estava atualizada."
          : "Mensagem publicada no mural.",
      );
      if (typeof window !== "undefined") {
        window.dispatchEvent(new Event(muralRefreshEventName(siteId)));
      }
    } catch (cause) {
      const apiFailure = cause as Partial<WeddingMessagesApiError>;
      const message = getMessageErrorMessage(cause);
      setError(message);
      if (
        apiFailure.code === "MESSAGE_CONFLICT" ||
        apiFailure.code === "MESSAGE_REMOVED"
      ) {
        await reload(true);
        setError(message);
      }
      if (apiFailure.status === 401) {
        loseSession();
        setError("");
      }
      toast.error(message);
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setReady(false);
    void reload(false);
  }, [open, reload]);

  const title = invitationMessage?.message
    ? "Sua mensagem"
    : "Deixe uma mensagem";

  return (
    <SiteDialog
      open={open}
      labelledBy="entrelacos-message-title"
      onClose={onClose}
    >
      {(requestClose) => (
        <div className="grid gap-6">
          <div className={siteDialogHeaderClass}>
            <div>
              <p className={siteDialogEyebrowClass}>Mural dos convidados</p>
              <h3
                className={siteDialogHeadingClass}
                id="entrelacos-message-title"
              >
                {title}
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
          {!ready ? (
            <p role="status">Carregando a mensagem deste convite…</p>
          ) : invitationMessage ? (
            <InvitationMessageForm
              message={invitationMessage.message}
              currentRevision={invitationMessage.currentRevision}
              canEdit={invitationMessage.canEdit}
              readOnlyReason={invitationMessage.readOnlyReason}
              value={messageDraft}
              busy={busy}
              error={error}
              onChange={(value) => {
                setMessageDraft(value);
                setError("");
              }}
              onSave={() => void save()}
              onReload={() => void reload(false)}
            />
          ) : (
            <div className="grid gap-4">
              <p className={invitationMessageAlertClass} role="alert">
                {error || "A mensagem deste convite não está disponível agora."}
              </p>
              <button
                type="button"
                className={siteDialogCloseClass}
                disabled={busy}
                onClick={() => void reload(false)}
              >
                Recarregar mensagem
              </button>
            </div>
          )}
        </div>
      )}
    </SiteDialog>
  );
}

const invitationMessageAlertClass =
  "m-0 max-w-[42rem] border border-template-line px-4 py-[0.8rem] text-template-ink";
