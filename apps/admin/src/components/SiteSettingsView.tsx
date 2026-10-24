import type {
  adminSummarySchema,
  SiteRecord,
  siteDomainRecordSchema,
} from "@entrelacos/contracts";
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@entrelacos/ui";
import { ChevronDown } from "lucide-react";
import { adminStyles } from "../lib/adminStyles";
import { formatBrazilianDate } from "./brazilianDate";
import { OverflowMenu } from "./OverflowMenu";
import { siteAdminMenuActions } from "./siteAdminMenu";
import {
  type LifecycleAction,
  siteLifecycleMenuActions,
} from "./siteLifecyclePresentation";
import {
  type SiteRecordMenuAction,
  siteRecordMenuActions,
} from "./siteRecordMenu";

type Admin = typeof adminSummarySchema._output;
type Domain = typeof siteDomainRecordSchema._output;
type SettingsSite = Pick<
  SiteRecord,
  | "displayName"
  | "coupleNames"
  | "eventDate"
  | "lifecycle"
  | "publicationState"
  | "publicUrl"
  | "termStartsOn"
  | "termEndsOn"
>;

export function SiteSettingsView({
  site,
  admins,
  domains,
  labels,
  pending,
  onEditRecord,
  onLifecycleAction,
  onAddAdmin,
  onAdminAction,
  onAddDomain,
  onEditDomain,
}: {
  site: SettingsSite;
  admins: Admin[];
  domains: Domain[];
  labels: Record<string, string>;
  pending: boolean;
  onEditRecord: (action: SiteRecordMenuAction) => void;
  onLifecycleAction: (action: LifecycleAction) => void;
  onAddAdmin: () => void;
  onAdminAction: (action: string, admin: Admin) => void;
  onAddDomain: () => void;
  onEditDomain: (domain: Domain) => void;
}) {
  return (
    <>
      <Card className={adminStyles.surface}>
        <CardHeader>
          <div className="flex flex-wrap items-center gap-3">
            <CardTitle>Situação do casamento</CardTitle>
            <Badge
              variant={site.lifecycle === "ACTIVE" ? "default" : "secondary"}
            >
              {labels[site.lifecycle]}
            </Badge>
          </div>
          <CardDescription>
            {site.lifecycle === "DRAFT"
              ? "Confira o cadastro antes de enviar o casamento para revisão."
              : site.lifecycle === "IN_REVIEW"
                ? "O casamento está pronto para conferência e aprovação."
                : site.lifecycle === "INACTIVE"
                  ? "Os dados estão preservados. Reative para liberar alterações à equipe."
                  : "O casamento está ativo. A vigência e a publicação podem ser conferidas abaixo."}
          </CardDescription>
          <CardAction>
            <OverflowMenu
              label="Ações da situação do casamento"
              disabled={pending}
              items={siteLifecycleMenuActions(site.lifecycle)}
              onSelect={(action) =>
                onLifecycleAction(action as LifecycleAction)
              }
            />
          </CardAction>
        </CardHeader>
      </Card>

      <section
        className="grid gap-4 xl:grid-cols-3"
        aria-label="Status e datas"
      >
        <Card className={adminStyles.surface}>
          <CardHeader>
            <CardTitle>Dados do casamento</CardTitle>
            <CardDescription>Identificação e endereço público.</CardDescription>
            <CardAction>
              <OverflowMenu
                label="Ações dos dados do casamento"
                disabled={pending}
                items={siteRecordMenuActions.filter(
                  (action) => action.id === "profile",
                )}
                onSelect={() => onEditRecord("profile")}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm">
              <div>
                <dt className="text-admin-muted">Nome do casamento</dt>
                <dd className="m-0 mt-1 font-medium text-admin-ink">
                  {site.displayName}
                </dd>
              </div>
              <div>
                <dt className="text-admin-muted">Casal</dt>
                <dd className="m-0 mt-1 font-medium text-admin-ink">
                  {site.coupleNames.join(" e ")}
                </dd>
              </div>
              <div>
                <dt className="text-admin-muted">Endereço público</dt>
                <dd className="m-0 mt-1 break-all text-admin-ink">
                  {site.publicUrl ?? "Ainda não informado"}
                </dd>
              </div>
            </dl>
          </CardContent>
        </Card>

        <Card className={adminStyles.surface}>
          <CardHeader>
            <CardTitle>Datas e vigência</CardTitle>
            <CardDescription>
              Data do evento e período contratado.
            </CardDescription>
            <CardAction>
              <OverflowMenu
                label="Ações das datas e vigência"
                disabled={pending}
                items={siteRecordMenuActions.filter(
                  (action) => action.id === "dates",
                )}
                onSelect={() => onEditRecord("dates")}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-4 text-sm">
              <div>
                <dt className="text-admin-muted">Data do casamento</dt>
                <dd className="m-0 mt-1 font-medium text-admin-ink">
                  {formatBrazilianDate(site.eventDate)}
                </dd>
              </div>
              <div>
                <dt className="text-admin-muted">Vigência</dt>
                <dd className="m-0 mt-1 font-medium text-admin-ink">
                  {site.termStartsOn
                    ? `${formatBrazilianDate(site.termStartsOn)} a ${formatBrazilianDate(site.termEndsOn ?? "")}`
                    : "Começa após a aprovação"}
                </dd>
              </div>
            </dl>
            <p className="mb-0 mt-4 text-sm leading-relaxed text-admin-muted">
              A aprovação inicia um ano de vigência. O vencimento não inativa o
              casamento automaticamente.
            </p>
          </CardContent>
        </Card>

        <Card className={adminStyles.surface}>
          <CardHeader>
            <CardTitle>Publicação do site</CardTitle>
            <CardDescription>
              Última situação registrada para o site.
            </CardDescription>
            <CardAction>
              <OverflowMenu
                label="Ações da publicação do site"
                disabled={pending}
                items={siteRecordMenuActions.filter(
                  (action) => action.id === "publication",
                )}
                onSelect={() => onEditRecord("publication")}
              />
            </CardAction>
          </CardHeader>
          <CardContent>
            <Badge variant="outline">{labels[site.publicationState]}</Badge>
            <p className="mb-0 mt-4 text-sm leading-relaxed text-admin-muted">
              Atualize este registro após conferir o site no ar. A publicação é
              realizada separadamente.
            </p>
          </CardContent>
        </Card>
      </section>

      <details className={`group ${adminStyles.surface}`}>
        <summary className="flex cursor-pointer list-none items-center gap-4 rounded-2xl p-6 outline-offset-4 marker:content-none">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-base font-semibold text-admin-ink">
              Acessos administrativos
            </h2>
            <p className="mb-0 mt-1 text-sm leading-relaxed text-admin-muted">
              {admins.length}{" "}
              {admins.length === 1
                ? "administrador cadastrado"
                : "administradores cadastrados"}
              . Gerencie quem acessa o painel.
            </p>
          </div>
          <ChevronDown
            className="size-4 shrink-0 text-admin-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="grid gap-4 border-t border-admin-line p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-sm text-admin-muted">
              Links de ativação e recuperação ficam nas ações de cada pessoa.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onAddAdmin}
            >
              Adicionar administrador
            </Button>
          </div>
          {admins.length === 0 ? (
            <p className="m-0 rounded-xl bg-admin-canvas p-4 text-sm text-admin-muted">
              Nenhum administrador cadastrado. Adicione uma pessoa para conceder
              acesso ao casamento.
            </p>
          ) : (
            <Table className="w-full">
              <TableHeader>
                <TableRow>
                  <TableHead>Pessoa</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {admins.map((admin) => (
                  <TableRow
                    className="border-b border-admin-line"
                    key={admin.userId}
                  >
                    <TableCell className="whitespace-normal">
                      <span className="block font-medium">{admin.name}</span>
                      <span className="mt-1 block break-all text-sm text-admin-muted">
                        {admin.email}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{labels[admin.state]}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <OverflowMenu
                        label={`Ações de ${admin.name}`}
                        disabled={pending}
                        items={siteAdminMenuActions(admin.state)}
                        onSelect={(action) => onAdminAction(action, admin)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </details>

      <details className={`group ${adminStyles.surface}`}>
        <summary className="flex cursor-pointer list-none items-center gap-4 rounded-2xl p-6 outline-offset-4 marker:content-none">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-base font-semibold text-admin-ink">
              Domínios
            </h2>
            <p className="mb-0 mt-1 text-sm leading-relaxed text-admin-muted">
              {domains.length}{" "}
              {domains.length === 1
                ? "endereço registrado"
                : "endereços registrados"}
              . Configuração e renovação.
            </p>
          </div>
          <ChevronDown
            className="size-4 shrink-0 text-admin-muted transition-transform group-open:rotate-180"
            aria-hidden="true"
          />
        </summary>
        <div className="grid gap-4 border-t border-admin-line p-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="m-0 text-sm text-admin-muted">
              Configuração, hospedagem e renovação são feitas separadamente.
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onAddDomain}
            >
              Registrar domínio
            </Button>
          </div>
          {domains.length === 0 ? (
            <p className="m-0 rounded-xl bg-admin-canvas p-4 text-sm text-admin-muted">
              Nenhum domínio registrado. Registre os endereços para acompanhar a
              configuração e a renovação.
            </p>
          ) : (
            <Table className="w-full">
              <TableHeader>
                <TableRow>
                  <TableHead>Endereço</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead>Renovação</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((domain) => (
                  <TableRow
                    className="border-b border-admin-line"
                    key={`${domain.id}-${domain.updatedAt}`}
                  >
                    <TableCell className="whitespace-normal">
                      <span className="block break-all font-medium">
                        {domain.hostname}
                      </span>
                      {domain.isPrimary && (
                        <span className="mt-1 block text-xs text-admin-muted">
                          Principal
                        </span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline">{labels[domain.state]}</Badge>
                    </TableCell>
                    <TableCell>
                      {domain.expiresOn
                        ? formatBrazilianDate(domain.expiresOn)
                        : "Não informada"}
                    </TableCell>
                    <TableCell className="text-right">
                      <OverflowMenu
                        label={`Ações de ${domain.hostname}`}
                        disabled={pending}
                        items={[{ id: "edit", label: "Editar domínio" }]}
                        onSelect={() => onEditDomain(domain)}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </details>
    </>
  );
}
