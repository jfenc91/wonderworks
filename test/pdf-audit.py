"""Inspect actual downloaded PDFs; emit page images and machine-readable results.
Run with the bundled Python runtime (pypdf, pdfplumber, pypdfium2, Pillow).
"""
import json, re, pathlib
from pypdf import PdfReader
import pdfplumber, pypdfium2
from PIL import Image, ImageOps, ImageDraw

out = pathlib.Path('outputs/pdf')
snapshot = json.loads((out/'captured-snapshot.json').read_text())
norm = lambda text: re.sub(r'\s+', ' ', text).strip()
report = {}
for name in ['accepted-a4', 'accepted-letter', 'snapshot-a4', 'snapshot-letter']:
    path = out/(name+'.pdf')
    reader = PdfReader(path)
    texts = [page.extract_text() for page in reader.pages]
    full = norm(' '.join(texts))
    assert len(reader.pages) >= 25
    assert not reader.is_encrypted
    assert reader.metadata.title and reader.trailer['/Root']['/Lang'] == 'en'
    assert reader.trailer['/Root']['/MarkInfo']['/Marked']
    assert 'PENDING PROPOSAL CONTENT MUST NOT APPEAR' not in full
    assert 'CURRENT SECTION MUST NOT APPEAR IN OLD SNAPSHOT' not in full
    for item in snapshot['requirements']:
        assert norm(item['id']+' · '+item['title']) in full, item['id']
        for criterion in item['criteria']: assert norm(criterion) in full, item['id']
        for key,value in item['parameters'].items(): assert norm(key) in full
        if item.get('body_format') == 'plain_text':
            # Running furniture is removed for an exact full-body comparison.
            body = norm(' '.join(re.sub(r'PDF QA café[^\n]*\n|Page \d+ of \d+[^\n]*', '', text) for text in texts))
            assert norm(item['description']) in body, 'Incomplete literal body'
    for value in ['Semantic heading', 'Ordered first', 'Ordered second', 'Unordered entry', 'Wide table caption', 'After full table', 'Before flow', 'Between diagrams', 'After diagrams', 'Ten-source Information summary', 'Figure references', 'Current review marker']:
        assert value in full, value
    assert 'Row 2 continued' in full
    assert 'Detail 1 of' in full
    assert 'Title not authored' in full
    assert len(reader.named_destinations) >= 110
    destinations = reader.named_destinations
    links = 0
    font_names = set()
    for i,page in enumerate(reader.pages):
        expected_width,expected_height = (612,792) if name.endswith('letter') else (595.28,841.89)
        assert abs(float(page.mediabox.width)-expected_width)<.1
        assert abs(float(page.mediabox.height)-expected_height)<.1
        assert f'Page {i+1} of {len(reader.pages)}' in texts[i]
        for ref in page.get('/Annots',[]):
            annot=ref.get_object(); action=annot.get('/A',{}).get_object()
            assert '/StructParent' in annot
            assert action.get('/S') in ['/GoTo','/URI']
            if action.get('/S')=='/GoTo': assert action['/D'] in destinations, action
            else: assert str(action['/URI']).startswith(('https://','http://'))
            links+=1
        for font in page['/Resources'].get('/Font',{}).values():
            f=font.get_object();font_names.add(str(f['/BaseFont']));assert '/ToUnicode' in f
            descendant=f['/DescendantFonts'][0].get_object();desc=descendant['/FontDescriptor'].get_object()
            assert any(key in desc for key in ['/FontFile','/FontFile2','/FontFile3'])
    tags={}; figure_alts=[]; table_headers=[]; objects=[]
    def visit(obj):
        if isinstance(obj,list):
            for child in obj: visit(child)
        elif hasattr(obj,'get_object'):
            obj=obj.get_object()
            if not hasattr(obj,'get'): return
            if '/S' in obj:
                tag=str(obj['/S']);tags[tag]=tags.get(tag,0)+1
                if tag=='/Figure': figure_alts.append(obj.get('/Alt'))
                if tag=='/TH': table_headers.append(obj.get('/A'))
                if tag=='/Link': objects.extend([c for c in obj.get('/K',[]) if hasattr(c,'get') and c.get('/Type')=='/OBJR'])
            if '/K' in obj:visit(obj['/K'])
    visit(reader.trailer['/Root']['/StructTreeRoot'])
    for tag in ['/H1','/H2','/P','/L','/LI','/Lbl','/LBody','/Table','/TR','/TH','/TD','/Link','/Figure']: assert tags.get(tag),tag
    assert all(figure_alts) and all(h['/Scope']=='/Column' for h in table_headers)
    assert len(objects)==links
    layout=[]
    with pdfplumber.open(path) as pdf:
        for i,page in enumerate(pdf.pages):
            for c in page.chars:
                if c.get('tag') in ['Figure',None]: continue # intentionally clipped overlapping detail tiles
                if c.get('tag')=='Artifact' and c['size']<9: continue # navigable figure overview
                if c['text'].strip() and (c['x0']<45 or c['x1']>page.width-44 or c['top']<44 or c['bottom']>page.height-44): layout.append([i+1,c['text'],c['x0'],c['top'],c['x1'],c['bottom']])
    assert not layout, layout[:20]
    pdf=pypdfium2.PdfDocument(path);folder=out/name;folder.mkdir(exist_ok=True)
    # Every page is rendered. Contact sheets support the complete visual pass;
    # full-resolution images of transitions, tables and figures are retained.
    thumbs=[]
    for i in range(len(pdf)):
        handle=pdf[i];bitmap=handle.render(scale=1);page_image=bitmap.to_pil().convert('RGB');bitmap.close();handle.close()
        page_image.save(folder/f'page-{i+1:03}.png')
        thumb=ImageOps.contain(page_image,(180,240));cell=Image.new('RGB',(200,265),'#dce0e3');cell.paste(thumb,((200-thumb.width)//2,5));ImageDraw.Draw(cell).text((8,248),str(i+1),fill='black');thumbs.append(cell)
    sheets=[]
    for offset in range(0,len(thumbs),48):
        sheet=Image.new('RGB',(1200,2120),'#aeb6bd')
        for i,thumb in enumerate(thumbs[offset:offset+48]):sheet.paste(thumb,((i%6)*200,(i//6)*265))
        sheet_path=out/f'{name}-contact-{offset//48+1}.jpg';sheet.save(sheet_path);sheets.append(str(sheet_path))
    report[name]={'pages':len(reader.pages),'links':links,'destinations':len(destinations),'fonts':sorted(font_names),'tags':tags,'all_pages_rendered':True,'layout_bound_violations':layout,'contact_sheets':sheets}
(out/'audit.json').write_text(json.dumps(report,indent=2))
print(json.dumps({key:{'pages':r['pages'],'links':r['links'],'figures':r['tags']['/Figure']} for key,r in report.items()},indent=2))
