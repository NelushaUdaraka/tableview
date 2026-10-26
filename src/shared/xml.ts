/**
 * Just enough XML for a showplan: elements and their attributes.
 *
 * SQL Server's plans are machine-written, well-formed, and say everything in
 * attributes — the text between tags is only ever whitespace — so this reads
 * elements and attributes and skips the rest (the declaration, comments,
 * text). It runs the same in the window and in the unit tests, which have no
 * DOMParser.
 */

export interface XmlElement {
  /** Without a namespace prefix. */
  name: string
  attrs: Record<string, string>
  children: XmlElement[]
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" }

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[entity] ?? whole
  })
}

const TOKEN = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<!DOCTYPE[^>]*>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g
const ATTRIBUTE = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g

function localName(name: string): string {
  const colon = name.indexOf(':')
  return colon >= 0 ? name.slice(colon + 1) : name
}

/** The document's root element. Throws on text that is not XML. */
export function parseXml(text: string): XmlElement {
  const stack: XmlElement[] = []
  let root: XmlElement | null = null
  for (const match of text.matchAll(TOKEN)) {
    const [, closing, name, attributes, selfClosing] = match
    if (name === undefined) continue
    if (closing) {
      const open = stack.pop()
      if (!open || open.name !== localName(name)) throw new Error(`Unexpected </${name}>`)
      continue
    }
    const attrs: Record<string, string> = {}
    for (const attribute of (attributes ?? '').matchAll(ATTRIBUTE)) {
      attrs[localName(attribute[1])] = decode(attribute[2] ?? attribute[3] ?? '')
    }
    const element: XmlElement = { name: localName(name), attrs, children: [] }
    const parent = stack[stack.length - 1]
    if (parent) parent.children.push(element)
    else if (!root) root = element
    if (!selfClosing) stack.push(element)
  }
  if (!root || stack.length > 0) throw new Error('Not a complete XML document')
  return root
}

/** The first child with this name. */
export function child(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((entry) => entry.name === name)
}

/** Every descendant with this name, in document order. */
export function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const visit = (node: XmlElement): void => {
    for (const entry of node.children) {
      if (entry.name === name) out.push(entry)
      visit(entry)
    }
  }
  visit(element)
  return out
}
