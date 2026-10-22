"use client";

import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DESCRICAO_DO_PAPEL,
  ROTULO_DO_PAPEL,
  rotuloDoPapel,
  type Role,
} from "@/lib/auth/types";

interface SeletorDePapelProps<P extends Role> {
  /** Papéis oferecidos — passe a mesma lista que o Zod do destino aceita. */
  papeis: ReadonlyArray<P>;
  value: P;
  onChange: (papel: P) => void;
  id?: string;
  "aria-label"?: string;
  /** Repete, abaixo do campo, a frase do papel escolhido (convite). */
  mostrarDescricao?: boolean;
  triggerClassName?: string;
}

/**
 * Escolha de papel com o nome leigo e a frase do que cada um pode fazer.
 * O campo fechado mostra só o nome (a frase vai na lista e, no convite,
 * abaixo do campo) para caber na linha da tabela da Equipe.
 */
export function SeletorDePapel<P extends Role>({
  papeis,
  value,
  onChange,
  id,
  "aria-label": ariaLabel,
  mostrarDescricao = false,
  triggerClassName,
}: SeletorDePapelProps<P>) {
  const idDescricao = id ? `${id}-descricao` : undefined;
  return (
    <div className="space-y-1.5">
      <Select value={value} onValueChange={(v) => onChange(v as P)}>
        <SelectTrigger
          id={id}
          aria-label={ariaLabel}
          aria-describedby={mostrarDescricao ? idDescricao : undefined}
          className={triggerClassName}
        >
          <SelectValue>{ROTULO_DO_PAPEL[value]}</SelectValue>
        </SelectTrigger>
        <SelectContent className="w-80 max-w-[calc(100vw-2rem)]">
          {papeis.map((papel) => (
            <SelectItem key={papel} value={papel} className="py-2">
              <span className="flex flex-col items-start gap-0.5">
                <span className="font-medium">{ROTULO_DO_PAPEL[papel]}</span>
                <span className="whitespace-normal text-xs text-muted-foreground">
                  {DESCRICAO_DO_PAPEL[papel]}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {mostrarDescricao ? (
        <p id={idDescricao} className="text-xs text-muted-foreground">
          {DESCRICAO_DO_PAPEL[value]}
        </p>
      ) : null}
    </div>
  );
}

/** Papel só para leitura (lista da Equipe para quem não administra). */
export function RotuloDoPapel({ papel, className }: { papel: string; className?: string }) {
  const descricao = Object.hasOwn(DESCRICAO_DO_PAPEL, papel)
    ? DESCRICAO_DO_PAPEL[papel as Role]
    : undefined;
  return (
    <Badge variant="secondary" title={descricao} className={className}>
      {rotuloDoPapel(papel)}
    </Badge>
  );
}
