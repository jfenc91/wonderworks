'use client';

import {ChevronRight, CircleDot, Link as LinkIcon} from 'lucide-react';
import type {Requirement} from '@/lib/types';
import {formatOf, normative} from '@/lib/item-content';
import {tagsOf} from '@/lib/tags';
import {RichContent, SourceLinks} from './rich-content';
import {TagBadges} from './requirement-tags';

/** The main reading surface is complete, independent of the optional inspector. */
export function RequirementItem({item, items, context, selected, pending, onRead, onEdit, onSelect, onTag}: {
  item: Requirement;
  items: Requirement[];
  context: string;
  selected: boolean;
  pending: boolean;
  onRead: () => void;
  onEdit: () => void;
  onSelect: (id: string) => void;
  onTag: (tag: string) => void;
}) {
  const isRequirement = normative(item);
  return <article className={'requirement-row ' + (selected ? 'selected' : '')} aria-labelledby={'requirement-title-' + item.id}>
    <div className="requirement-meta">
      <span className="req-id">{item.id}</span>
      <span className={'badge ' + item.status.toLowerCase()}><CircleDot size={10}/>{isRequirement ? (pending ? 'Pending → Approved on Apply' : item.status) : 'Editorial: ' + item.status}</span>
      <span className="priority">{isRequirement ? item.priority : 'Information · Non-normative'} · {formatOf(item)}</span>
      <span className="req-id">r{item.revision}</span>
    </div>
    <h3 className="requirement-title" id={'requirement-title-' + item.id}>{item.title}</h3>
    <RichContent item={item}/>
    {item.criteria.length > 0 && <section className="inline-criteria" aria-label={'Acceptance criteria for ' + item.id}>
      <h4>Acceptance criteria</h4>
      <ol>{item.criteria.map((criterion, index) => <li key={index}>{criterion}</li>)}</ol>
    </section>}
    {Object.keys(item.parameters).length > 0 && <section className="inline-parameters" aria-label={'Specified parameters for ' + item.id}>
      <h4>Specified parameters</h4>
      <dl className="parameters">{Object.entries(item.parameters).map(([name, value]) => <div key={name}><dt>{name}</dt><dd><code>{String(value)}</code></dd></div>)}</dl>
    </section>}
    {item.links.length > 0 && <section className="inline-dependencies" aria-label={'Dependencies for ' + item.id}>
      <h4>Depends on</h4>
      <ul>{item.links.map(id => <li key={id}><button className="dependency-link" onClick={() => onSelect(id)}><LinkIcon size={12}/>{id} · {items.find(r => r.id === id)?.title ?? 'Unavailable'}</button></li>)}</ul>
    </section>}
    {tagsOf(item).length > 0 && <section aria-label={'Tags for ' + item.id}><h4>Tags</h4><TagBadges tags={tagsOf(item)} onSelect={onTag}/></section>}
    <SourceLinks item={item} items={items} context={context} onSelect={onSelect}/>
    <button className="requirement-select reader-affordance" id={'requirement-select-' + item.id} onClick={onRead} onDoubleClick={onEdit}>Inspect {item.id}<ChevronRight size={14}/></button>
  </article>;
}
