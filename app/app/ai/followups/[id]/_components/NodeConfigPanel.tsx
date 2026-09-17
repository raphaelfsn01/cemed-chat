"use client";

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus, Trash } from "@/lib/ui/icons";
import {
  waitConfigSchema,
  conditionConfigSchema,
  aiClassifyConfigSchema,
  actionConfigSchema,
  endConfigSchema,
  type FlowNode,
  type ConditionField,
} from "@/lib/followup/graph-schema";
import {
  CAMPOS_OFERECIDOS,
  CAMPO_AJUDA,
  CAMPO_LABEL,
  CAMPO_SEM_PRODUTOR,
  OPERADORES_POR_CAMPO,
  TIPO_DO_VALOR,
  descreverCheck,
  operadorPadraoDoCampo,
  valorPadraoDoCampo,
  type Check,
} from "@/lib/followup/vocabulary";
import { usePipelines, usePipelineStages } from "@/hooks/webhooks/useWebhookSources";
import { useMessageTemplates } from "@/hooks/inbox/useMessageTemplates";
import type { RFNode, RFNodeData } from "@/lib/followup/graph-mappers";
import { NODE_VISUALS } from "./nodes/nodeVisuals";

type ConfigOf<T extends FlowNode["type"]> = Extract<FlowNode, { type: T }>["config"];

interface Props {
  node: RFNode;
  onChange: (patch: Partial<RFNodeData>) => void;
}

/**
 * Zod-driven config form, one variant per node type. Each field commits to
 * the live React Flow node (`onChange`) only when the candidate config
 * passes its schema — otherwise the field shows an inline error and the
 * canvas keeps the last valid config (never a half-written value upstream).
 */
export function NodeConfigPanel({ node, onChange }: Props) {
  const type = node.type as FlowNode["type"];
  const visual = NODE_VISUALS[type];
  const Icon = visual.icon;
  const [label, setLabel] = useState(node.data.label);
  const [labelError, setLabelError] = useState<string | null>(null);

  const commitLabel = (value: string) => {
    setLabel(value);
    if (value.trim().length < 1 || value.length > 60) {
      setLabelError("Rótulo precisa ter 1 a 60 caracteres.");
      return;
    }
    setLabelError(null);
    onChange({ label: value });
  };

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto" data-testid="node-config-panel">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold text-text">
          <span className={`flex h-6 w-6 items-center justify-center rounded-full ${visual.chipClassName}`}>
            <Icon size={14} aria-hidden />
          </span>
          {visual.paletteLabel}
        </h2>
        <p className="text-sm text-text-muted">
          Alterações aplicam no rascunho ao digitar — salve na barra de publicação.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="node-label">Rótulo</Label>
        <Input
          id="node-label"
          value={label}
          maxLength={60}
          onChange={(e) => commitLabel(e.target.value)}
        />
        {labelError && <p className="text-xs text-error-fg">{labelError}</p>}
      </div>

      <div className="space-y-4 border-t border-border pt-4">
        {type === "trigger" && (
          <p className="text-sm text-text-muted">
            Início do fluxo — sem configuração adicional. O disparo (manual, mudança de
            etapa, silêncio ou fim de conversa) é definido nas configurações do fluxo.
          </p>
        )}
        {type === "wait" && (
          <WaitForm config={node.data.config as ConfigOf<"wait">} onChange={(config) => onChange({ config })} />
        )}
        {type === "condition" && (
          <ConditionForm
            config={node.data.config as ConfigOf<"condition">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "ai_classify" && (
          <ClassifyForm
            config={node.data.config as ConfigOf<"ai_classify">}
            onChange={(config) => onChange({ config })}
          />
        )}
        {type === "action" && (
          <ActionForm config={node.data.config as ConfigOf<"action">} onChange={(config) => onChange({ config })} />
        )}
        {type === "end" && (
          <EndForm config={node.data.config as ConfigOf<"end">} onChange={(config) => onChange({ config })} />
        )}
      </div>
    </div>
  );
}

// ─── wait ────────────────────────────────────────────────────────────────

function msToMin(ms: number): number {
  return Math.round(ms / 60_000);
}
function minToMs(min: number): number {
  return Math.round(min * 60_000);
}

function WaitForm({
  config,
  onChange,
}: {
  config: ConfigOf<"wait">;
  onChange: (c: ConfigOf<"wait">) => void;
}) {
  const [mode, setMode] = useState<"fixed" | "smart">(config.mode);
  const [durationMin, setDurationMin] = useState(
    config.mode === "fixed" ? msToMin(config.duration_ms) : 10,
  );
  const [minMin, setMinMin] = useState(config.mode === "smart" ? msToMin(config.min_ms) : 5);
  const [maxMin, setMaxMin] = useState(config.mode === "smart" ? msToMin(config.max_ms) : 60);
  const [guidance, setGuidance] = useState(config.mode === "smart" ? (config.guidance ?? "") : "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: {
    mode: "fixed" | "smart";
    durationMin: number;
    minMin: number;
    maxMin: number;
    guidance: string;
  }) => {
    const candidate =
      next.mode === "fixed"
        ? { mode: "fixed" as const, duration_ms: minToMs(next.durationMin) }
        : {
            mode: "smart" as const,
            min_ms: minToMs(next.minMin),
            max_ms: minToMs(next.maxMin),
            ...(next.guidance.trim() ? { guidance: next.guidance } : {}),
          };
    const parsed = waitConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="wait-mode">Modo</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "fixed" | "smart";
            setMode(next);
            commit({ mode: next, durationMin, minMin, maxMin, guidance });
          }}
        >
          <SelectTrigger id="wait-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fixed">Fixo</SelectItem>
            <SelectItem value="smart">Adaptativo (hoje espera o máximo)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "fixed" ? (
        <div className="space-y-2">
          <Label htmlFor="wait-duration">Duração (minutos)</Label>
          <Input
            id="wait-duration"
            type="number"
            min={5}
            value={durationMin}
            onChange={(e) => {
              const v = Number(e.target.value);
              setDurationMin(v);
              commit({ mode, durationMin: v, minMin, maxMin, guidance });
            }}
          />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="wait-min">Mínimo (min)</Label>
              <Input
                id="wait-min"
                type="number"
                min={5}
                value={minMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMinMin(v);
                  commit({ mode, durationMin, minMin: v, maxMin, guidance });
                }}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="wait-max">Máximo (min)</Label>
              <Input
                id="wait-max"
                type="number"
                min={5}
                value={maxMin}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  setMaxMin(v);
                  commit({ mode, durationMin, minMin, maxMin: v, guidance });
                }}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="wait-guidance">Orientação (opcional)</Label>
            <Textarea
              id="wait-guidance"
              maxLength={500}
              value={guidance}
              onChange={(e) => {
                setGuidance(e.target.value);
                commit({ mode, durationMin, minMin, maxMin, guidance: e.target.value });
              }}
            />
          </div>
        </>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── condition ───────────────────────────────────────────────────────────

/**
 * Editor de condição. Três decisões que o código sozinho não explica:
 *
 * - **o valor é tipado pelo campo** (número, etapa do funil, texto). Antes ele
 *   era sempre string, e como o avaliador só compara `gte`/`lte` entre dois
 *   números (`node-handlers.ts`), toda condição numérica editada por aqui
 *   ficava permanentemente falsa — publicando normalmente, sem erro nenhum;
 * - **trocar de campo reseta operador e valor**, senão sobra id de etapa dentro
 *   de um campo numérico;
 * - **campo sem produtor no motor não é oferecido**, mas continua sendo exibido
 *   com aviso quando já está salvo — sumir com ele levaria a configuração junto.
 *
 * Campos e operadores vêm de `lib/followup/vocabulary.ts`, que por sua vez lê os
 * enums do schema. Redeclarar as listas aqui foi como a tela passou a oferecer
 * combinações que o motor nunca torna verdadeiras.
 */
function ConditionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"condition">;
  onChange: (c: ConfigOf<"condition">) => void;
}) {
  const [combinator, setCombinator] = useState(config.combinator);
  const [checks, setChecks] = useState<Check[]>(config.checks);
  const [error, setError] = useState<string | null>(null);

  // Etapas só são buscadas quando alguma condição fala de etapa.
  const usaEtapa = checks.some((c) => TIPO_DO_VALOR[c.field] === "etapa");
  const { data: pipelinesRes } = usePipelines();
  const pipelines = pipelinesRes?.data ?? [];
  const [pipelineEscolhido, setPipelineEscolhido] = useState<string | null>(null);
  const pipelineId = pipelineEscolhido ?? pipelines[0]?.id ?? null;
  const { data: boardRes, isLoading: etapasCarregando } = usePipelineStages(
    usaEtapa ? pipelineId : null,
  );
  const stages = boardRes?.data?.stages ?? [];
  const nomeDaEtapa = (id: string) => stages.find((s) => s.id === id)?.name;

  const commit = (nextCombinator: "and" | "or", nextChecks: Check[]) => {
    const parsed = conditionConfigSchema.safeParse({ combinator: nextCombinator, checks: nextChecks });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  /** Troca de campo reseta operador e valor — tipos diferentes não se aproveitam. */
  const trocarCampo = (idx: number, field: ConditionField) => {
    const next = checks.map((c, i) =>
      i === idx
        ? { field, op: operadorPadraoDoCampo(field), value: valorPadraoDoCampo(field) }
        : c,
    );
    setChecks(next);
    commit(combinator, next);
  };

  const atualizar = (idx: number, patch: Partial<Check>) => {
    const next = checks.map((c, i) => (i === idx ? { ...c, ...patch } : c));
    setChecks(next);
    commit(combinator, next);
  };

  return (
    <div className="space-y-3">
      {usaEtapa && pipelines.length > 1 && (
        <div className="space-y-2">
          <Label htmlFor="cond-pipeline">Funil das etapas</Label>
          <Select value={pipelineId ?? ""} onValueChange={(v) => setPipelineEscolhido(v)}>
            <SelectTrigger id="cond-pipeline">
              <SelectValue placeholder="Escolha o funil" />
            </SelectTrigger>
            <SelectContent>
              {pipelines.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="cond-combinator">Combinador</Label>
        <Select
          value={combinator}
          onValueChange={(v) => {
            const next = v as "and" | "or";
            setCombinator(next);
            commit(next, checks);
          }}
        >
          <SelectTrigger id="cond-combinator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="and">E (todas)</SelectItem>
            <SelectItem value="or">OU (qualquer uma)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        {checks.map((check, idx) => (
          <div key={idx} className="space-y-2 rounded-sm border border-border p-2" data-testid={`condition-check-${idx}`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-text-muted">Condição {idx + 1}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remover condição"
                disabled={checks.length <= 1}
                onClick={() => {
                  const next = checks.filter((_, i) => i !== idx);
                  setChecks(next);
                  commit(combinator, next);
                }}
              >
                <Trash size={14} aria-hidden />
              </Button>
            </div>
            <Select
              value={check.field}
              onValueChange={(v) => trocarCampo(idx, v as ConditionField)}
            >
              <SelectTrigger aria-label="Campo">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {/* Campo já salvo que não é mais oferecido continua na lista, senão
                    escolher outro seria a única saída — e a configuração se perderia. */}
                {(CAMPOS_OFERECIDOS.includes(check.field)
                  ? CAMPOS_OFERECIDOS
                  : [check.field, ...CAMPOS_OFERECIDOS]
                ).map((f) => (
                  <SelectItem key={f} value={f}>
                    {CAMPO_LABEL[f]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={check.op}
              onValueChange={(v) => atualizar(idx, { op: v as Check["op"] })}
            >
              <SelectTrigger aria-label="Operador">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPERADORES_POR_CAMPO[check.field].map((o) => (
                  <SelectItem key={o.op} value={o.op}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {TIPO_DO_VALOR[check.field] === "numero" && (
              <Input
                aria-label="Valor"
                type="number"
                min={0}
                value={Number(check.value)}
                onChange={(e) => atualizar(idx, { value: Number(e.target.value) })}
              />
            )}
            {TIPO_DO_VALOR[check.field] === "etapa" && (
              <Select
                value={String(check.value)}
                onValueChange={(v) => atualizar(idx, { value: v })}
                disabled={etapasCarregando || stages.length === 0}
              >
                <SelectTrigger aria-label="Valor">
                  <SelectValue placeholder={etapasCarregando ? "Carregando etapas…" : "Escolha a etapa"} />
                </SelectTrigger>
                <SelectContent>
                  {stages.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {TIPO_DO_VALOR[check.field] === "texto" && (
              <Input
                aria-label="Valor"
                placeholder="Valor"
                value={String(check.value)}
                onChange={(e) => atualizar(idx, { value: e.target.value })}
              />
            )}

            <p className="text-xs text-text-muted">{CAMPO_AJUDA[check.field]}</p>
            <p className="text-xs text-text">{descreverCheck(check, { nomeDaEtapa })}</p>
            {CAMPO_SEM_PRODUTOR[check.field] && (
              <p className="text-xs text-warning-fg">{CAMPO_SEM_PRODUTOR[check.field]}</p>
            )}
          </div>
        ))}
      </div>

      <Button
        type="button"
        variant="secondary"
        size="sm"
        disabled={checks.length >= 10}
        onClick={() => {
          const next: Check[] = [
            ...checks,
            {
              field: "steps_taken",
              op: operadorPadraoDoCampo("steps_taken"),
              value: valorPadraoDoCampo("steps_taken"),
            },
          ];
          setChecks(next);
          commit(combinator, next);
        }}
      >
        <Plus size={14} aria-hidden className="mr-1" /> Condição
      </Button>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── ai_classify ─────────────────────────────────────────────────────────

function ClassifyForm({
  config,
  onChange,
}: {
  config: ConfigOf<"ai_classify">;
  onChange: (c: ConfigOf<"ai_classify">) => void;
}) {
  const [classesText, setClassesText] = useState(config.classes.join(", "));
  const [graceMin, setGraceMin] = useState(msToMin(config.grace_timeout_ms));
  // Sem setter: "Alvo" saiu da tela, mas o valor salvo é preservado no commit.
  const [target] = useState(config.target);
  const [hint, setHint] = useState(config.hint ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { classesText: string; graceMin: number; target: "last_reply" | "summary"; hint: string }) => {
    const classes = next.classesText
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    const candidate = {
      classes,
      grace_timeout_ms: minToMs(next.graceMin),
      target: next.target,
      ...(next.hint.trim() ? { hint: next.hint } : {}),
    };
    const parsed = aiClassifyConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="classify-classes">Classes (separadas por vírgula)</Label>
        <Input
          id="classify-classes"
          value={classesText}
          onChange={(e) => {
            setClassesText(e.target.value);
            commit({ classesText: e.target.value, graceMin, target, hint });
          }}
          placeholder="hot, cold, no_reply"
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="classify-grace">Grace (minutos, mín. 15)</Label>
        <Input
          id="classify-grace"
          type="number"
          min={15}
          value={graceMin}
          onChange={(e) => {
            const v = Number(e.target.value);
            setGraceMin(v);
            commit({ classesText, graceMin: v, target, hint });
          }}
        />
      </div>
      {/* "Alvo" (last_reply/summary) saiu da tela: o schema aceita, mas nenhum
          consumidor do runtime lê o campo — escolher ali não mudava nada. O valor
          salvo continua sendo preservado pelo estado acima. */}
      <div className="space-y-2">
        <Label htmlFor="classify-hint">Instrução (opcional)</Label>
        <Textarea
          id="classify-hint"
          maxLength={500}
          value={hint}
          onChange={(e) => {
            setHint(e.target.value);
            commit({ classesText, graceMin, target, hint: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── action ──────────────────────────────────────────────────────────────

/** Radix não aceita "" como valor de item; este sentinela representa "nenhum". */
const SEM_TEMPLATE = "__sem_template__";

function ActionForm({
  config,
  onChange,
}: {
  config: ConfigOf<"action">;
  onChange: (c: ConfigOf<"action">) => void;
}) {
  const [mode, setMode] = useState(config.mode);
  const [promptHint, setPromptHint] = useState(config.mode === "ai_message" ? config.prompt_hint : "");
  const [fallbackTemplateId, setFallbackTemplateId] = useState(
    config.mode === "ai_message" ? (config.fallback_template_id ?? "") : "",
  );
  const [templateId, setTemplateId] = useState(config.mode === "template" ? config.template_id : "");
  const [error, setError] = useState<string | null>(null);
  const { data: templates = [] } = useMessageTemplates();

  const commit = (next: {
    mode: "ai_message" | "template";
    promptHint: string;
    fallbackTemplateId: string;
    templateId: string;
  }) => {
    const candidate =
      next.mode === "ai_message"
        ? {
            mode: "ai_message" as const,
            prompt_hint: next.promptHint,
            ...(next.fallbackTemplateId.trim() ? { fallback_template_id: next.fallbackTemplateId } : {}),
          }
        : { mode: "template" as const, template_id: next.templateId };
    const parsed = actionConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="action-mode">Modo</Label>
        <Select
          value={mode}
          onValueChange={(v) => {
            const next = v as "ai_message" | "template";
            setMode(next);
            commit({ mode: next, promptHint, fallbackTemplateId, templateId });
          }}
        >
          <SelectTrigger id="action-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="ai_message">Mensagem gerada por IA</SelectItem>
            {/* O motor nunca lê `template_id` — este modo não envia nada. Fica
                desabilitado em vez de sumir, para que um nó salvo com ele
                continue abrindo e possa ser corrigido. */}
            <SelectItem value="template" disabled>
              Template fixo (indisponível)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {mode === "ai_message" ? (
        <>
          <div className="space-y-2">
            <Label htmlFor="action-prompt-hint">Instrução para a IA</Label>
            <Textarea
              id="action-prompt-hint"
              maxLength={1000}
              value={promptHint}
              onChange={(e) => {
                setPromptHint(e.target.value);
                commit({ mode, promptHint: e.target.value, fallbackTemplateId, templateId });
              }}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="action-fallback">Resposta rápida de reserva (opcional)</Label>
            <Select
              value={fallbackTemplateId || SEM_TEMPLATE}
              onValueChange={(v) => {
                const next = v === SEM_TEMPLATE ? "" : v;
                setFallbackTemplateId(next);
                commit({ mode, promptHint, fallbackTemplateId: next, templateId });
              }}
            >
              <SelectTrigger id="action-fallback">
                <SelectValue placeholder="Nenhuma" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SEM_TEMPLATE}>Nenhuma</SelectItem>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-text-muted">
              Exigida pela publicação quando o caminho até esta ação acumula 24h ou mais de
              espera. As opções vêm de Respostas rápidas.
            </p>
          </div>
        </>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-warning-fg">
            Este nó está no modo Template fixo, que o motor não executa — ele não envia
            mensagem. Troque para “Mensagem gerada por IA”.
          </p>
          <Label htmlFor="action-template-id">Template configurado</Label>
          <Select
            value={templateId || SEM_TEMPLATE}
            onValueChange={(v) => {
              const next = v === SEM_TEMPLATE ? "" : v;
              setTemplateId(next);
              commit({ mode, promptHint, fallbackTemplateId, templateId: next });
            }}
          >
            <SelectTrigger id="action-template-id">
              <SelectValue placeholder="Nenhum" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEM_TEMPLATE}>Nenhum</SelectItem>
              {templates.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  {t.title}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}

// ─── end ─────────────────────────────────────────────────────────────────

function EndForm({ config, onChange }: { config: ConfigOf<"end">; onChange: (c: ConfigOf<"end">) => void }) {
  const [outcome, setOutcome] = useState(config.outcome);
  const [note, setNote] = useState(config.note ?? "");
  const [error, setError] = useState<string | null>(null);

  const commit = (next: { outcome: "converted" | "exhausted" | "custom"; note: string }) => {
    const candidate = { outcome: next.outcome, ...(next.note.trim() ? { note: next.note } : {}) };
    const parsed = endConfigSchema.safeParse(candidate);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Configuração inválida.");
      return;
    }
    setError(null);
    onChange(parsed.data);
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label htmlFor="end-outcome">Resultado</Label>
        <Select
          value={outcome}
          onValueChange={(v) => {
            const next = v as "converted" | "exhausted" | "custom";
            setOutcome(next);
            commit({ outcome: next, note });
          }}
        >
          <SelectTrigger id="end-outcome">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="converted">Convertido</SelectItem>
            <SelectItem value="exhausted">Esgotado</SelectItem>
            <SelectItem value="custom">Personalizado</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-2">
        <Label htmlFor="end-note">Nota (opcional)</Label>
        <Textarea
          id="end-note"
          maxLength={200}
          value={note}
          onChange={(e) => {
            setNote(e.target.value);
            commit({ outcome, note: e.target.value });
          }}
        />
      </div>
      {error && <p className="text-xs text-error-fg">{error}</p>}
    </div>
  );
}
