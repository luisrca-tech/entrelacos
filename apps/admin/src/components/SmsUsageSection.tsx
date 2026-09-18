import type { SmsUsageResponse } from "@entrelacos/contracts";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
} from "@entrelacos/ui";
import { useCallback, useEffect, useState } from "react";
import { adminStyles, displayHeading } from "../lib/adminStyles";
import { ApiError, apiRequest } from "../lib/apiClient";
import { smsUsageProgress } from "./smsUsage";

type Props = {
  siteId: string;
  lifecycle: "DRAFT" | "IN_REVIEW" | "ACTIVE" | "INACTIVE";
  owner: boolean;
};

const alertLabels: Record<SmsUsageResponse["alert"], string> = {
  NOT_CONFIGURED: "SMS real não configurado",
  BELOW_80: "Uso abaixo de 80%",
  AT_OR_ABOVE_80: "Uso em 80% ou mais",
  AT_OR_ABOVE_100: "Limite atingido",
};

function usageError(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === "SITE_INACTIVE") {
    return "A cota não pode ser alterada enquanto o site estiver inativo.";
  }
  return cause instanceof Error
    ? cause.message
    : "Não foi possível consultar o uso de SMS.";
}

export function SmsUsageSection({ siteId, lifecycle, owner }: Props) {
  const [usage, setUsage] = useState<SmsUsageResponse | null>(null);
  const [limit, setLimit] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inactive = lifecycle === "INACTIVE";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<SmsUsageResponse>(
        `/v1/sites/${encodeURIComponent(siteId)}/sms-usage`,
      );
      setUsage(result);
      setLimit(result.monthlyLimit === null ? "" : String(result.monthlyLimit));
      setError("");
    } catch (cause) {
      setError(usageError(cause));
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveLimit() {
    const monthlyLimit = Number(limit);
    if (
      !owner ||
      inactive ||
      limit === "" ||
      !Number.isInteger(monthlyLimit) ||
      monthlyLimit < 0 ||
      monthlyLimit > 1_000_000
    ) {
      setError("Informe uma cota inteira entre 0 e 1.000.000.");
      return;
    }
    setPending(true);
    setError("");
    setNotice("");
    try {
      await apiRequest(
        `/v1/owner/sites/${encodeURIComponent(siteId)}/sms-quota`,
        { method: "PATCH", body: { monthlyLimit } },
      );
      await load();
      setNotice("Cota mensal de SMS atualizada.");
    } catch (cause) {
      setError(usageError(cause));
    } finally {
      setPending(false);
    }
  }

  const progress = usage
    ? smsUsageProgress(usage.realSms.consumed, usage.monthlyLimit)
    : null;

  return (
    <section className={adminStyles.card} aria-labelledby="sms-usage-title">
      <div className="flex items-end justify-between gap-3.5 max-[760px]:grid max-[760px]:grid-cols-1">
        <div>
          <h2
            className={`m-0 mb-[18px] text-[clamp(1.8rem,3vw,2.7rem)] ${displayHeading}`}
            id="sms-usage-title"
          >
            SMS e PIN manual
          </h2>
          <p>
            O PIN compartilhado manualmente é o acesso padrão do MVP e continua
            disponível sem cota de SMS. A simulação não envia mensagens nem
            representa custo do provedor.
          </p>
        </div>
        {usage && <Badge variant="outline">{alertLabels[usage.alert]}</Badge>}
      </div>
      {error && (
        <p className={adminStyles.alert} role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="my-3.5 text-admin-muted" role="status">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status">Carregando uso mensal…</p>
      ) : !usage ? (
        <p role="status">Uso mensal indisponível.</p>
      ) : (
        <>
          <p>
            Período de {new Date(usage.periodStart).toLocaleDateString("pt-BR")}{" "}
            a {new Date(usage.periodEnd).toLocaleDateString("pt-BR")} no fuso{" "}
            {usage.timezone}.
          </p>
          {progress === null ? (
            <p className={adminStyles.notice}>
              Nenhuma cota foi configurada. O envio real permanece bloqueado.
            </p>
          ) : (
            <label className="my-5 grid gap-2 font-semibold">
              Uso real: {usage.realSms.consumed} de {usage.monthlyLimit}
              <progress max={100} value={progress} />
            </label>
          )}
          <div className="my-6 grid gap-4">
            <Card className="rounded-[10px] border border-admin-line bg-admin-beige p-5">
              <CardHeader>
                <CardTitle>SMS real</CardTitle>
                <CardDescription>
                  {usage.realSms.consumed} reservas consumidas
                </CardDescription>
              </CardHeader>
              <CardContent>
                <small>
                  {usage.realSms.providerAccepted} aceitas pelo provedor ·{" "}
                  {usage.realSms.failedFinal} falhas finais ·{" "}
                  {usage.realSms.unknown} desconhecidas ·{" "}
                  {usage.realSms.reserved} reservadas
                </small>
              </CardContent>
            </Card>
            <Card className="rounded-[10px] border border-admin-line bg-admin-beige p-5">
              <CardHeader>
                <CardTitle>Simulação</CardTitle>
                <CardDescription>
                  {usage.simulated.consumed} reservas de teste
                </CardDescription>
              </CardHeader>
              <CardContent>
                <small>
                  Não são envios Twilio, não indicam entrega e não representam
                  custo real.
                </small>
              </CardContent>
            </Card>
          </div>
        </>
      )}
      {owner && (
        <div className="mt-5 flex items-end gap-4 max-[760px]:grid max-[760px]:grid-cols-1">
          <label
            className="grid flex-1 basis-60 gap-2 text-[0.88rem] font-semibold text-admin-graphite"
            htmlFor="sms-monthly-limit"
          >
            Cota mensal de SMS real
            <Input
              id="sms-monthly-limit"
              type="number"
              min={0}
              max={1_000_000}
              step={1}
              value={limit}
              disabled={inactive || pending}
              placeholder="Sem cota configurada"
              onChange={(event) => setLimit(event.target.value)}
            />
          </label>
          <Button
            type="button"
            disabled={inactive || pending || limit === ""}
            onClick={() => void saveLimit()}
          >
            {pending ? "Salvando…" : "Salvar cota"}
          </Button>
        </div>
      )}
    </section>
  );
}
