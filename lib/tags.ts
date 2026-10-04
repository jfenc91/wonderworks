import {kindOf,normative,itemSearchText} from './item-content';
import type {Requirement} from './types';

export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_RAW_TAG_LENGTH = 100;
export const TAG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function normalizeTag(value: string): string {
  return value.trim().replace(/[A-Z]/g, c => c.toLowerCase()).replace(/\s+/g, '-');
}

export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_TAGS) throw Error('Provide an array of up to 20 tags.');
  const tags = value.map((raw, index) => {
    if (typeof raw !== 'string' || raw.length > MAX_RAW_TAG_LENGTH) throw Error(`Tag ${index + 1}: use at most 100 text characters.`);
    const tag = normalizeTag(raw);
    if (!tag || tag.length > MAX_TAG_LENGTH || !TAG_PATTERN.test(tag)) {
      throw Error(`Tag ${index + 1}: use 1–40 letters, numbers, or single hyphens between words. Spaces become hyphens.`);
    }
    return tag;
  });
  return [...new Set(tags)].sort();
}

export const tagsOf = (requirement: Pick<Requirement, 'tags'>) => normalizeTags(requirement.tags ?? []);
export const withTags = (requirement: Requirement): Requirement & {tags: string[]} => ({...requirement, tags: tagsOf(requirement)});
export type RequirementFilters = {query?: string; kind?:'requirement'|'information'; section?: string; status?: string; tags?: string[]; tag_mode?: 'any'|'all'; untagged_only?: boolean};

/** Shared by the reading surface and MCP, before pagination or counts. */
export function matchesRequirement(requirement: Requirement, filters: RequirementFilters): boolean {
  const tags = tagsOf(requirement), selected = filters.tags ?? [];
  return (!filters.section || requirement.section === filters.section)
    && (!filters.kind || kindOf(requirement) === filters.kind)
    && (!filters.status || normative(requirement)&&requirement.status === filters.status)
    && (!filters.query || [itemSearchText(requirement), ...tags].join(' ').toLowerCase().includes(filters.query.toLowerCase()))
    && (!filters.untagged_only || tags.length === 0)
    && (!selected.length || (filters.tag_mode === 'all' ? selected.every(tag => tags.includes(tag)) : selected.some(tag => tags.includes(tag))));
}

export function tagInventory(requirements: Requirement[], filters: RequirementFilters = {}): {tag: string; count: number}[] {
  const counts = new Map<string, number>();
  for (const requirement of requirements) {
    for (const tag of tagsOf(requirement)) {
      counts.set(tag, (counts.get(tag) ?? 0) + (matchesRequirement(requirement, {...filters, tags: [], untagged_only: false}) ? 1 : 0));
    }
  }
  return [...counts].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([tag, count]) => ({tag, count}));
}
