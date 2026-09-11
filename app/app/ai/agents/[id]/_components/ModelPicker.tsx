"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/lib/api/client";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type Provider = "anthropic" | "openai" | "google" | "openrouter";

export interface ModelOption {
  provider: Provider;
  model_id: string;
  display_name: string;
  context_window: number | null;
  is_default_for_provider: boolean;
}

interface Props {
  provider: Provider;
  /**
   * FABRICANTE do modelo (prefixo do `model_id`: "anthropic", "deepseek", …).
   *
   * Existe porque, na OpenRouter, um único provider reúne modelos de vários
   * fabricantes — e a tela mantém a experiência de "escolhe a empresa, depois o
   * modelo". Filtrar aqui (em memória) em vez de na rota é de propósito: o
   * catálogo é curado e pequeno, e uma busca por fabricante faria a lista
   * piscar a cada troca sem ganho nenhum.
   *
   * Ausente = não filtra, que é o comportamento de quem não conhece este campo.
   */
  vendor?: string;
  value: string;
  onChange: (modelId: string, ctx?: { contextWindow: number | null }) => void;
  disabled?: boolean;
  id?: string;
}

interface ApiResponse {
  data: { models: ModelOption[] };
}

/** Modelos do fabricante pedido. Sem fabricante, devolve tudo. */
export function filtrarPorFabricante(models: ModelOption[], vendor?: string): ModelOption[] {
  if (!vendor) return models;
  return models.filter((m) => m.model_id.startsWith(`${vendor}/`));
}

/** Fabricantes presentes no catálogo, em ordem alfabética, sem repetição. */
export function fabricantesDoCatalogo(models: ModelOption[]): string[] {
  const vistos = new Set<string>();
  for (const m of models) {
    const v = m.model_id.split("/")[0];
    // Id sem barra não tem fabricante (é o formato dos providers diretos, não o
    // da OpenRouter) — fica de fora em vez de virar uma opção vazia na tela.
    if (v && v !== m.model_id) vistos.add(v);
  }
  return [...vistos].sort();
}

export function ModelPicker({ provider, vendor, value, onChange, disabled, id }: Props) {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });

  const models = filtrarPorFabricante(query.data ?? [], vendor);

  return (
    <div className="space-y-1">
      <Label htmlFor={id}>Modelo</Label>
      <Select
        value={value || undefined}
        onValueChange={(v) => {
          const m = models.find((m) => m.model_id === v);
          onChange(v, { contextWindow: m?.context_window ?? null });
        }}
        disabled={disabled || query.isLoading}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={query.isLoading ? "Carregando…" : "Selecione um modelo"} />
        </SelectTrigger>
        <SelectContent>
          {models.map((m) => (
            <SelectItem key={m.model_id} value={m.model_id}>
              {m.display_name}
              {m.is_default_for_provider ? " · default" : ""}
            </SelectItem>
          ))}
          {models.length === 0 && !query.isLoading ? (
            <SelectItem value="__none__" disabled>
              Nenhum modelo disponível
            </SelectItem>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Fabricantes disponíveis no catálogo deste provider.
 *
 * Usa a MESMA queryKey do ModelPicker de propósito: o react-query devolve do
 * cache em vez de buscar de novo, então a tela não faz duas chamadas para a
 * mesma lista.
 */
export function useFabricantes(provider: Provider): { vendors: string[]; isLoading: boolean } {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });
  return { vendors: fabricantesDoCatalogo(query.data ?? []), isLoading: query.isLoading };
}

export function useModelMeta(provider: Provider, modelId: string): ModelOption | null {
  const query = useQuery({
    queryKey: ["ai", "providers", provider, "models"],
    queryFn: async () => {
      const res = await apiClient.get<ApiResponse>(`/api/v1/ai/providers/${provider}/models`);
      return res.data.models;
    },
    staleTime: 60_000,
  });
  return (query.data ?? []).find((m) => m.model_id === modelId) ?? null;
}
