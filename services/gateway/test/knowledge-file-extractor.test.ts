import { describe, expect, it } from "vitest";

import { AppError } from "../src/errors/app-error.js";
import {
  DOCX_MAX_ENTRIES,
  KNOWLEDGE_FILE_MAX_BYTES,
  extractKnowledgeFile,
} from "../src/knowledge/knowledge-file-extractor.js";

describe("knowledge file extraction", () => {
  it("extracts bounded UTF-8 TXT and sanitizes a Windows fakepath title", async () => {
    await expect(
      extractKnowledgeFile({
        filename: "C:\\fakepath\\architecture.txt",
        contentType: "text/plain",
        bytes: Buffer.from("Gateway\r\nowns authorization."),
      }),
    ).resolves.toEqual({
      title: "architecture",
      sourceType: "file_txt",
      content: "Gateway\r\nowns authorization.",
    });
  });

  it("extracts text from a valid PDF without rendering", async () => {
    const result = await extractKnowledgeFile({
      filename: "deployment.pdf",
      contentType: "application/pdf",
      bytes: tinyPdf("Deployment requires approval"),
    });
    expect(result).toMatchObject({
      title: "deployment",
      sourceType: "file_pdf",
    });
    expect(result.content).toContain("Deployment requires approval");
  }, 15_000);

  it("extracts only the bounded Word document XML from DOCX", async () => {
    const result = await extractKnowledgeFile({
      filename: "notes.docx",
      contentType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: docx("Private &amp; bounded"),
    });
    expect(result).toEqual({
      title: "notes",
      sourceType: "file_docx",
      content: "Private & bounded",
    });
  });

  it.each([
    [
      "script.exe",
      "application/octet-stream",
      Buffer.from("MZ"),
      "KNOWLEDGE_FILE_UNSUPPORTED",
    ],
    [
      "fake.pdf",
      "application/pdf",
      Buffer.from("not pdf"),
      "KNOWLEDGE_FILE_INVALID",
    ],
    [
      "fake.docx",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      Buffer.from("PK fake"),
      "KNOWLEDGE_FILE_INVALID",
    ],
    [
      "macro.docm",
      "application/vnd.ms-word.document.macroEnabled.12",
      docx("macro"),
      "KNOWLEDGE_FILE_UNSUPPORTED",
    ],
    [
      "binary.txt",
      "text/plain",
      Buffer.from([0x4d, 0x5a, 0, 1]),
      "KNOWLEDGE_FILE_INVALID",
    ],
    [
      "invalid.txt",
      "text/plain",
      Buffer.from([0xc3, 0x28]),
      "KNOWLEDGE_FILE_INVALID",
    ],
    ["empty.txt", "text/plain", Buffer.from("  \n"), "KNOWLEDGE_FILE_NO_TEXT"],
    [
      "wrong.txt",
      "application/pdf",
      Buffer.from("text"),
      "KNOWLEDGE_FILE_UNSUPPORTED",
    ],
  ])(
    "rejects unsupported, mismatched, binary, or empty input",
    async (filename, contentType, bytes, code) => {
      await expectCode(
        extractKnowledgeFile({ filename, contentType, bytes }),
        code,
      );
    },
  );

  it("rejects path traversal and excessive-entry DOCX archives", async () => {
    await expectCode(
      extractKnowledgeFile({
        filename: "unsafe.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip([
          ...docxEntries("safe"),
          { name: "../escape.xml", content: "x" },
        ]),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );
    await expectCode(
      extractKnowledgeFile({
        filename: "many.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip([
          ...docxEntries("safe"),
          ...Array.from({ length: DOCX_MAX_ENTRIES }, (_, index) => ({
            name: `custom/item-${index}.xml`,
            content: "x",
          })),
        ]),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );
  });

  it("rejects ambiguous, macro-enabled, and externally rooted DOCX packages", async () => {
    const entries = docxEntries("safe");
    await expectCode(
      extractKnowledgeFile({
        filename: "duplicate.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip([
          ...entries,
          { name: "word/document.xml", content: entries[2]!.content },
        ]),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );

    await expectCode(
      extractKnowledgeFile({
        filename: "renamed-macro.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip(
          entries.map((entry) =>
            entry.name === "[Content_Types].xml"
              ? {
                  ...entry,
                  content: entry.content.replace(
                    "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
                    "application/vnd.ms-word.document.macroEnabled.main+xml",
                  ),
                }
              : entry,
          ),
        ),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );

    await expectCode(
      extractKnowledgeFile({
        filename: "external.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip(
          entries.map((entry) =>
            entry.name === "_rels/.rels"
              ? {
                  ...entry,
                  content: entry.content.replace(
                    'Target="word/document.xml"',
                    'Target="https://example.invalid/document.xml" TargetMode="External"',
                  ),
                }
              : entry,
          ),
        ),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );
  });

  it("rejects oversized uploads, textless PDFs, and compression-bomb metadata", async () => {
    await expectCode(
      extractKnowledgeFile({
        filename: "large.txt",
        contentType: "text/plain",
        bytes: Buffer.alloc(KNOWLEDGE_FILE_MAX_BYTES + 1, 0x61),
      }),
      "KNOWLEDGE_FILE_TOO_LARGE",
    );
    await expectCode(
      extractKnowledgeFile({
        filename: "blank.pdf",
        contentType: "application/pdf",
        bytes: tinyPdf(""),
      }),
      "KNOWLEDGE_FILE_NO_TEXT",
    );
    await expectCode(
      extractKnowledgeFile({
        filename: "bomb.docx",
        contentType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        bytes: zip([
          ...docxEntries("safe"),
          {
            name: "custom/compressed.xml",
            content: "x",
            declaredCompressedSize: 1,
            declaredUncompressedSize: 1000,
          },
        ]),
      }),
      "KNOWLEDGE_FILE_INVALID",
    );
  });
});

async function expectCode(promise: Promise<unknown>, code: string) {
  try {
    await promise;
    throw new Error("Expected extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
}

function tinyPdf(text: string): Buffer {
  const escaped = text
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)");
  const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, "ascii");
}

function docx(text: string): Buffer {
  return zip(docxEntries(text));
}

function docxEntries(text: string) {
  return [
    {
      name: "[Content_Types].xml",
      content:
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    },
    {
      name: "_rels/.rels",
      content:
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: "word/document.xml",
      content: `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p></w:body></w:document>`,
    },
  ];
}

function zip(
  entries: readonly {
    name: string;
    content: string;
    declaredCompressedSize?: number;
    declaredUncompressedSize?: number;
  }[],
): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const content = Buffer.from(entry.content, "utf8");
    const compressedSize = entry.declaredCompressedSize ?? content.length;
    const uncompressedSize = entry.declaredUncompressedSize ?? content.length;
    const crc = crc32(content);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0x0800, 6);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressedSize, 18);
    header.writeUInt32LE(uncompressedSize, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, content);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(compressedSize, 20);
    directory.writeUInt32LE(uncompressedSize, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + content.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
