import {
  type ReceivingKycLink,
  receivingKycLinkSchema,
} from "@entrelacos/contracts";
import { ArrowUpRight, ScanFace } from "lucide-react";
import { useRef, useState } from "react";
import { ApiError, apiRequest } from "../lib/apiClient";
import {
  receivingBody,
  receivingLink,
  receivingPrimaryAction,
} from "./receivingUi";

// Pagar.me keeps each identity verification link valid for 20 minutes.
const linkLifetimeMinutes = 20;

export type IdentityVerificationRequest = (
  path: string,
  options: { method: string; body: unknown },
) => Promise<unknown>;
/** A tab opened during the click, before the link exists (pop-up blockers). */
export interface VerificationTab {
  navigate(url: string): void;
  close(): void;
}
type OpenTab = () => VerificationTab | null;

const expiryFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

// Each call asks the API for a fresh short-lived link; the link is never
// stored, so a reload or a second click always gets a new one.
export async function requestIdentityVerificationLink(
  siteId: string,
  request: IdentityVerificationRequest = apiRequest,
): Promise<ReceivingKycLink> {
  return receivingKycLinkSchema.parse(
    await request(
      `/v1/owner/sites/${encodeURIComponent(siteId)}/receiving/kyc-link`,
      { method: "POST", body: undefined },
    ),
  );
}

function browserOpenTab(): VerificationTab | null {
  if (typeof window === "undefined") return null;
  // Opened synchronously in the click so blockers allow it; the Pagar.me URL
  // is set once the API answers. The opener link is cut before navigating.
  const tab = window.open("about:blank", "_blank");
  if (!tab) return null;
  try {
    tab.opener = null;
  } catch {}
  return {
    navigate: (url) => tab.location.replace(url),
    close: () => tab.close(),
  };
}

/** The KYC QR arrives as base64 PNG or SVG; declare the matching type. */
export function kycQrImageSource(base64: string): string {
  const type = /^(PD94|PHN2)/.test(base64)
    ? "image/svg+xml"
    : base64.startsWith("/9j/")
      ? "image/jpeg"
      : "image/png";
  return `data:${type};base64,${base64}`;
}

/** Pagar.me has not asked for the selfie and document yet. */
function kycLinkUnavailable(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "RECEIVING_KYC_LINK_UNAVAILABLE"
  );
}

export function ReceivingIdentityVerification({
  siteId,
  request,
  openTab = browserOpenTab,
  disabled = false,
  onUnavailable,
}: {
  siteId: string;
  request?: IdentityVerificationRequest;
  openTab?: OpenTab;
  disabled?: boolean;
  /** Reloads the setup status when Pagar.me refuses the link. */
  onUnavailable?: () => void;
}) {
  const [state, setState] = useState<{
    status: "idle" | "loading" | "ready" | "error" | "unavailable";
    link: ReceivingKycLink | null;
  }>({ status: "idle", link: null });
  const attempt = useRef(0);
  async function generate() {
    const current = ++attempt.current;
    const tab = openTab();
    setState({ status: "loading", link: null });
    try {
      const link = await requestIdentityVerificationLink(siteId, request);
      if (attempt.current !== current) {
        tab?.close();
        return;
      }
      tab?.navigate(link.url);
      setState({ status: "ready", link });
    } catch (error) {
      tab?.close();
      if (attempt.current !== current) return;
      if (kycLinkUnavailable(error)) {
        setState({ status: "unavailable", link: null });
        onUnavailable?.();
      } else setState({ status: "error", link: null });
    }
  }
  const { link, status } = state;
  const expiresAt = link ? new Date(link.expiresAt) : null;
  return (
    <div className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          className={receivingPrimaryAction}
          disabled={disabled || status === "loading"}
          onClick={() => void generate()}
        >
          <ScanFace aria-hidden="true" className="size-[18px]" />
          {status === "loading"
            ? "Gerando link…"
            : link
              ? "Gerar novo link"
              : "Verificar identidade"}
        </button>
        <p className="m-0 text-[0.82rem] text-admin-text-secondary">
          Abre a Pagar.me em uma nova aba.
        </p>
      </div>
      {status === "error" && (
        <p
          role="alert"
          className="m-0 rounded-[14px] bg-admin-danger-subtle p-4 text-sm leading-[1.55] text-admin-danger-text"
        >
          Não foi possível gerar o link de verificação. Tente novamente em
          instantes.
        </p>
      )}
      {status === "unavailable" && (
        <p
          role="status"
          className="m-0 rounded-[14px] bg-admin-pending-subtle p-4 text-sm leading-[1.55] text-admin-pending-text"
        >
          A Pagar.me ainda não liberou a verificação de identidade deste
          cadastro. A situação foi atualizada nesta página. Volte mais tarde: o
          botão funciona assim que a Pagar.me pedir o documento e a selfie.
        </p>
      )}
      {link && (
        <div
          role="status"
          className="flex min-w-0 flex-wrap items-center gap-5 rounded-[14px] border border-admin-border bg-admin-canvas p-5"
        >
          <img
            src={kycQrImageSource(link.base64QrCode)}
            alt="QR Code para verificar a identidade no celular"
            width={168}
            height={168}
            className="size-[168px] shrink-0 rounded-[10px] border border-admin-border bg-admin-surface p-2"
          />
          <div className="grid min-w-0 flex-1 basis-56 gap-2">
            <p className="m-0 text-[0.95rem] font-bold text-admin-text">
              Prefere o celular? Aponte a câmera para o QR Code.
            </p>
            <p className={receivingBody}>
              O link vale por {linkLifetimeMinutes} minutos
              {expiresAt && !Number.isNaN(expiresAt.getTime()) && (
                <>
                  , até{" "}
                  <time dateTime={link.expiresAt}>
                    {expiryFormatter.format(expiresAt)}
                  </time>
                </>
              )}
              . Se expirar, gere outro.
            </p>
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className={`${receivingLink} inline-flex w-fit items-center gap-1 text-sm`}
            >
              A aba não abriu? Abrir a verificação
              <ArrowUpRight aria-hidden="true" className="size-4" />
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
