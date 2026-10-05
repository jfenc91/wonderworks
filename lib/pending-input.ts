// Capture still-open form input before a remotely deleted workspace unmounts.
// Keep this only in memory; recovery never submits it to another project.
export function recoverFormInput(){
  return (Array.from(document.querySelectorAll('form input,form textarea,form select,[role="dialog"] input,[role="dialog"] textarea,[role="dialog"] select,.review-decision textarea')) as unknown as (HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement)[])
    .filter((field,index,all)=>all.indexOf(field)===index&&!field.closest('[data-workspace-deletion],[data-recovery-ignore]')&&!['password','file','hidden','submit','button'].includes(field.type))
    .map((field,index)=>{
      const label=field.getAttribute('aria-label')||field.labels?.[0]?.textContent?.trim()||field.name||`Field ${index+1}`;
      const value=field instanceof HTMLInputElement&&['checkbox','radio'].includes(field.type)?String(field.checked):field.value;
      return `${label}\n${value}`;
    }).join('\n\n');
}
