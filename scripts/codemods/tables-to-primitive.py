#!/usr/bin/env python3
"""
Raw <table> markup → components/ui/table primitives, one file at a time.

  python3 scripts/codemods/tables-to-primitive.py <file.tsx> [...]

The raw tables were regular: `<table className="w-full text-sm">`, a header row
carrying `border-b border-border bg-muted/40 text-left text-xs
text-muted-foreground`, cells carrying `px-3 py-2`. The primitive now supplies
exactly those, so the transform strips what the primitive provides and keeps
what the cell added (alignment, mono, colour, colSpan).

Tables whose <thead> is `sticky` are left alone on purpose: the primitive's
root wraps the table in its own overflow container, which would become the
sticky header's scroll ancestor and pin it to nothing.
"""
import re, sys, pathlib

IMPORT = 'import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"'

def strip_tokens(cls: str, tokens) -> str:
    parts = [t for t in cls.split() if t not in tokens]
    return " ".join(parts)

def rewrite_cell(m, tag):
    attrs = m.group(1)
    new_tag = "TableHead" if tag == "th" else "TableCell"
    drop = {"px-3", "py-2"} | ({"font-medium"} if tag == "th" else set())
    def fix_str(mm):
        cls = strip_tokens(mm.group(1), drop)
        return f'className="{cls}"' if cls else ""
    def fix_cn(mm):
        cls = strip_tokens(mm.group(1), drop)
        rest = mm.group(2)
        if cls:
            return f'className={{cn("{cls}", {rest})}}'
        # cn("px-3 py-2 font-medium", col.align) → className={col.align}
        return f"className={{{rest}}}"
    attrs = re.sub(r'className="([^"]*)"', fix_str, attrs)
    attrs = re.sub(r'className=\{cn\("([^"]*)",\s*([^)]*)\)\}', fix_cn, attrs)
    attrs = re.sub(r"\s{2,}", " ", attrs).rstrip()
    return f"<{new_tag}{attrs}>"

HEADER_ROW_CLASSES = [
    "border-b border-border bg-muted/40 text-left text-xs text-muted-foreground",
    "border-b border-border text-left text-xs text-muted-foreground",
]
BODY_ROW_TOKENS = {"border-b", "border-t", "border-border", "last:border-0", "hover:bg-muted/40", "hover:bg-muted/30"}

def rewrite_row(m):
    attrs = m.group(1)
    def fix(mm):
        cls = mm.group(1)
        if cls in HEADER_ROW_CLASSES:
            return ""
        if cls == "text-left text-[10px] uppercase tracking-wide text-muted-foreground":
            return 'className="text-[10px] uppercase tracking-wide"'
        cls = strip_tokens(cls, BODY_ROW_TOKENS)
        return f'className="{cls}"' if cls else ""
    attrs = re.sub(r'className="([^"]*)"', fix, attrs)
    attrs = re.sub(r"\s{2,}", " ", attrs).rstrip()
    return f"<TableRow{attrs}>"

def transform_block(block: str) -> str:
    block = re.sub(r'<table className="w-full text-sm">', "<Table>", block)
    block = re.sub(r'<table className="w-full text-xs">', '<Table className="text-xs">', block)
    block = block.replace("</table>", "</Table>")
    block = re.sub(r"<thead>", "<TableHeader>", block)
    block = re.sub(r'<thead className="([^"]*)">', r'<TableHeader className="\1">', block)
    block = block.replace("</thead>", "</TableHeader>")
    block = block.replace("<tbody>", "<TableBody>").replace("</tbody>", "</TableBody>")
    block = re.sub(r"<tr((?:\s[^>]*)?)>", rewrite_row, block)
    block = block.replace("</tr>", "</TableRow>")
    block = re.sub(r"<th((?:\s[^>]*)?)>", lambda m: rewrite_cell(m, "th"), block)
    block = block.replace("</th>", "</TableHead>")
    block = re.sub(r"<td((?:\s[^>]*)?)>", lambda m: rewrite_cell(m, "td"), block)
    block = block.replace("</td>", "</TableCell>")
    return block

for path in sys.argv[1:]:
    p = pathlib.Path(path); src = p.read_text()
    out, i, done, skipped = [], 0, 0, 0
    while True:
        a = src.find("<table", i)
        if a == -1:
            out.append(src[i:]); break
        b = src.find("</table>", a) + len("</table>")
        block = src[a:b]
        out.append(src[i:a])
        known = re.match(r'<table className="w-full text-(sm|xs)">', block)
        if "sticky" in block or not known:
            # Unknown table shapes (e.g. a border-separate heatmap grid) are a
            # person's job; converting only the rows would leave a raw <table>
            # closed by </Table>.
            out.append(block); skipped += 1
        else:
            out.append(transform_block(block)); done += 1
        i = b
    s = "".join(out)
    if done and 'from "@/components/ui/table"' not in s and "from '@/components/ui/table'" not in s:
        last = max(m.end() for m in re.finditer(r"^import [^\n]*\n(?:(?!import)[^\n]*\n)*?(?=\S)", s, flags=re.M)) if False else None
        # place after the last top-level import statement
        ms = list(re.finditer(r"^import [\s\S]*?\n(?=(?:\n|[^\s]))", s, flags=re.M))
        idx = ms[-1].end() if ms else 0
        s = s[:idx] + IMPORT + "\n" + s[idx:]
    p.write_text(s)
    print(f"{path}: {done} table(s) converted, {skipped} sticky table(s) left as-is")
