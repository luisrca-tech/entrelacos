import { originSchema, publicUrlSchema } from "@entrelacos/contracts";

export function validatePublicAddress(raw: string) {
  const value = raw.trim();
  if (!value) return { value: { publicUrl: null } };
  if (!publicUrlSchema.safeParse(value).success)
    return {
      error:
        "Informe um endereço público completo com https://, sem caminho, consulta ou fragmento.",
    };
  return { value: { publicUrl: value } };
}

export function validateTrustedOrigins(raw: string) {
  const values = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (values.length > 20)
    return { error: "Informe até 20 endereços autorizados." };
  if (new Set(values).size !== values.length)
    return { error: "Remova os endereços repetidos." };
  if (values.some((value) => !originSchema.safeParse(value).success))
    return {
      error:
        "Use uma origem por linha, com https:// e o domínio, sem barra ou caminho no final.",
    };
  return { value: { trustedOrigins: values } };
}
