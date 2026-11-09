export function AsaasDisclosure() {
  return (
    <section
      aria-label="Prestador dos serviços financeiros"
      className="grid min-w-0 gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm leading-relaxed text-slate-800"
    >
      <a
        href="https://asaas.com"
        target="_blank"
        rel="noopener noreferrer"
        className="w-fit rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-slate-800"
      >
        <img
          src="https://baas.asaas.com/selos/Servicos_financeiros_Asaas-Reduzida-Positivo.svg?id=cf7ab943-556a-41e9-bb76-66a301ce446c"
          alt="Serviços financeiros Asaas"
          width={160}
          height={48}
          referrerPolicy="strict-origin-when-cross-origin"
          className="block h-12 w-40 max-w-full object-contain"
        />
        <span className="sr-only"> (abre em outra aba)</span>
      </a>
      <p className="m-0">
        Os serviços financeiros e de pagamento são prestados pelo Asaas Gestão
        Financeira Instituição de Pagamentos S.A., instituição de pagamento
        autorizada pelo Banco Central do Brasil. O Entrelaços atua como
        integrador tecnológico e não é instituição financeira ou de pagamento.
      </p>
      <p className="m-0">
        Suporte Asaas para operações financeiras:{" "}
        <a
          href="mailto:contato@asaas.com.br"
          className="break-words underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4"
        >
          contato@asaas.com.br
        </a>
        . Telefone 0800 009 0037 (somente pessoa jurídica); mensagens para 0800
        009 0037.
      </p>
    </section>
  );
}
