'use client';

import {forwardRef, useId, useImperativeHandle, useState} from 'react';
import {Tag, X} from 'lucide-react';
import {Combobox, ComboboxInput, ComboboxContent, ComboboxList, ComboboxItem, ComboboxEmpty} from '@/components/ui/combobox';
import {Select, SelectTrigger, SelectValue, SelectContent, SelectItem} from '@/components/ui/select';
import {Checkbox} from '@/components/ui/checkbox';
import {normalizeTags, type RequirementFilters} from '@/lib/tags';

export function TagBadges({tags = [], onSelect, onRemove}: {tags?: string[]; onSelect?: (tag: string) => void; onRemove?: (tag: string) => void}) {
  if (!tags.length) return null;
  return <div className="requirement-tags" aria-label="Assigned tags">{tags.map(tag => onRemove
    ? <button className="requirement-tag" type="button" key={tag} onClick={() => onRemove(tag)} aria-label={'Remove tag '+tag}>{tag}<X size={13}/></button>
    : onSelect
      ? <button className="requirement-tag" type="button" key={tag} onClick={() => onSelect(tag)} aria-label={'Filter by tag '+tag}><Tag size={12}/>{tag}</button>
      : <span className="requirement-tag" key={tag}><Tag size={12}/>{tag}</span>)}</div>;
}

export type TagEditorHandle = {readTags: () => string[]};
export const TagEditor = forwardRef<TagEditorHandle, {value: string[]; suggestions: string[]; onChange: (tags: string[]) => void}>(function TagEditor({value, suggestions, onChange}, ref) {
  const id = useId(), [input, setInput] = useState(''), [error, setError] = useState('');
  let candidate = '';
  try { if (input.trim()) candidate = normalizeTags([input])[0]; } catch { /* Show validation when adding or saving. */ }
  const choices = [...new Set([...suggestions, ...value])].sort().filter(tag => tag.includes(input.trim().toLowerCase()) || tag.includes(candidate || input));
  if (candidate && !choices.includes(candidate)) choices.push(candidate);
  function readTags() {
    if (!input.trim()) return normalizeTags(value);
    const tag = normalizeTags([input])[0];
    return normalizeTags(value.includes(tag) ? value : [...value, tag]);
  }
  useImperativeHandle(ref, () => ({readTags}));
  function add(tag?: string) {
    try { onChange(tag ? normalizeTags(value.includes(tag) ? value : [...value, tag]) : readTags()); setInput(''); setError(''); }
    catch (e) { setError((e as Error).message); }
  }
  return <div className="tag-editor">
    <label htmlFor={id}>Tags <span className="tag-limit">{value.length} / 20</span></label>
    <TagBadges tags={value} onRemove={tag => {onChange(value.filter(t => t !== tag)); setError('');}}/>
    <div className="tag-add-row">
      <Combobox items={choices} filter={null} value={null} inputValue={input} onInputValueChange={(value,details) => {if(details.reason !== 'item-press')setInput(value);}} onValueChange={(tag: string|null) => {if (tag) add(tag);}} autoHighlight>
        <ComboboxInput id={id} aria-label="Tags" className="tag-combobox" placeholder="Add or find a tag…" maxLength={100} aria-describedby={id+'-hint'} onKeyDown={event => {if (event.key === 'Enter' && !choices.length) {event.preventDefault(); add();}}}/>
        <ComboboxContent className="tag-options"><ComboboxEmpty>{input ? 'Use letters, numbers, and hyphens.' : 'Type a tag, such as mcp or security.'}</ComboboxEmpty><ComboboxList>{(tag: string) => <ComboboxItem key={tag} value={tag}>{!suggestions.includes(tag) && !value.includes(tag) ? 'Create '+tag : tag}</ComboboxItem>}</ComboboxList></ComboboxContent>
      </Combobox>
      <button type="button" className="secondary" disabled={!input.trim()} onClick={() => add()}>Add tag</button>
    </div>
    <div className="tag-editor-footer"><p className="field-hint" id={id+'-hint'}>For example: mcp, security, reliability. Spaces become hyphens.</p>{value.length > 0 && <button type="button" className="clear-filter" onClick={() => {onChange([]); setInput(''); setError('');}}>Clear all tags</button>}</div>
    {error && <p className="error-box" role="alert">{error}</p>}
  </div>;
});

export function TagFilters({inventory, filters, onChange, resultCount, context}: {inventory: {tag: string; count: number}[]; filters: RequirementFilters; onChange: (value: RequirementFilters) => void; resultCount: number; context: string[]}) {
  const id = useId(), selected = filters.tags ?? [], [search, setSearch] = useState('');
  const choices = inventory.filter(({tag}) => tag.includes(search.toLowerCase())).map(({tag}) => tag);
  return <div className="tag-filters">
    <div className="tag-filter-controls">
      <Combobox multiple items={choices} filter={null} value={selected} inputValue={search} onInputValueChange={setSearch} onValueChange={(tags: string[], details) => {if(details.reason==='escape-key')return;onChange({...filters, tags: [...tags].sort(), untagged_only: false}); setSearch('');}}>
        <ComboboxInput className="tag-combobox" aria-label="Filter by tags" placeholder="Filter by tags…"/>
        <ComboboxContent className="tag-options"><ComboboxEmpty>{inventory.length ? 'No matching tags.' : 'No tags assigned yet. Add tags in a requirement.'}</ComboboxEmpty><ComboboxList>{(tag: string) => <ComboboxItem key={tag} value={tag} disabled={!selected.includes(tag) && selected.length >= 20}><span>{tag}</span><span className="tag-option-count">{inventory.find(i => i.tag === tag)?.count ?? 0}</span></ComboboxItem>}</ComboboxList></ComboboxContent>
      </Combobox>
      <Select value={filters.tag_mode ?? 'any'} onValueChange={tag_mode => onChange({...filters, tag_mode: tag_mode as 'any'|'all'})} disabled={!selected.length}><SelectTrigger aria-label="Tag match mode"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="any">Any tag</SelectItem><SelectItem value="all">All tags</SelectItem></SelectContent></Select>
      <label className="untagged-filter" htmlFor={id}><Checkbox id={id} checked={!!filters.untagged_only} onCheckedChange={checked => onChange({...filters, untagged_only: checked === true, tags: []})}/>Untagged</label>
    </div>
    <div className="tag-filter-summary"><span role="status">{resultCount} matching requirement{resultCount === 1 ? '' : 's'}</span>{context.length > 0 && <span className="filter-context">{context.join(' · ')}</span>}</div>
    {(selected.length > 0 || filters.untagged_only) && <div className="active-tag-filters">
      {selected.length > 0 && <><span className="filter-mode-label">Match {filters.tag_mode === 'all' ? 'all' : 'any'}:</span><TagBadges tags={selected} onRemove={tag => onChange({...filters, tags: selected.filter(t => t !== tag)})}/></>}
      {filters.untagged_only && <span className="requirement-tag">Untagged</span>}
      <button className="clear-filter" type="button" onClick={() => onChange({tags: [], tag_mode: 'any', untagged_only: false})}>Clear tag filter</button>
    </div>}
  </div>;
}
