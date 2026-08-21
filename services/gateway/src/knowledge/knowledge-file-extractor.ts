import { extname } from "node:path";

import * as yauzl from "yauzl";

import { AppError } from "../errors/app-error.js";
import type { KnowledgeSourceType } from "./knowledge-service.js";
import {
  KNOWLEDGE_CONTENT_MAX_BYTES,
  hasForbiddenControlCharacter,
} from "./text-normalizer.js";

export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DOCX_MAX_ENTRIES = 200;
export const DOCX_MAX_ENTRY_BYTES = 10 * 1024 * 1024;
export const DOCX_MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
export const DOCX_MAX_COMPRESSION_RATIO = 100;

export interface ExtractedKnowledgeFile {
  readonly title: string;
  readonly content: string;
  readonly sourceType: KnowledgeSourceType;
}

export async function extractKnowledgeFile(input: {
  readonly filename: string;
  readonly contentType: string;
  readonly bytes: Buffer;
}): Promise<ExtractedKnowledgeFile> {
  if (input.bytes.length === 0) throw noText();
  if (input.bytes.length > KNOWLEDGE_FILE_MAX_BYTES) throw tooLarge();
  const filename = basenameAcrossPlatforms(input.filename);
  const extension = extname(filename).toLowerCase();
  const title = deriveTitle(filename, extension);

  if (extension === ".txt") {
    requireMime(input.contentType, ["text/plain"]);
    return Object.freeze({
      title,
      sourceType: "file_txt",
      content: extractTxt(input.bytes),
    });
  }
  if (extension === ".pdf") {
    requireMime(input.contentType, ["application/pdf"]);
    return Object.freeze({
      title,
      sourceType: "file_pdf",
      content: await extractPdf(input.bytes),
    });
  }
  if (extension === ".docx") {
    requireMime(input.contentType, [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    return Object.freeze({
      title,
      sourceType: "file_docx",
      content: await extractDocx(input.bytes),
    });
  }
  throw unsupported();
}

function extractTxt(bytes: Buffer): string {
  if (hasKnownBinarySignature(bytes) || bytes.includes(0)) throw invalid();
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalid();
  }
  if (content.trim().length === 0) throw noText();
  if (hasUnsafeExtractedControl(content)) throw invalid();
  assertExtractedBound(content);
  return content;
}

async function extractPdf(bytes: Buffer): Promise<string> {
  if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii")))
    throw invalid();
  try {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loadingTask = getDocument({
      data: new Uint8Array(bytes),
      isEvalSupported: false,
      useSystemFonts: false,
      stopAtErrors: true,
      disableAutoFetch: true,
      disableStream: true,
      verbosity: 0,
    });
    const pdf = await loadingTask.promise;
    try {
      if (pdf.numPages > 500) throw invalid();
      const pages: string[] = [];
      let extractedBytes = 0;
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
        const page = await pdf.getPage(pageNumber);
        const text = await page.getTextContent();
        const pageText = text.items
          .map((item) => ("str" in item ? item.str : ""))
          .filter(Boolean)
          .join(" ");
        extractedBytes += Buffer.byteLength(pageText, "utf8") + 1;
        if (extractedBytes > KNOWLEDGE_CONTENT_MAX_BYTES) throw tooLarge();
        pages.push(pageText);
      }
      const content = pages.join("\n\n").trim();
      if (content.length === 0) throw noText();
      if (hasUnsafeExtractedControl(content)) throw invalid();
      return content;
    } finally {
      await pdf.destroy();
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw extractionFailed();
  }
}

async function extractDocx(bytes: Buffer): Promise<string> {
  if (!isZip(bytes)) throw invalid();
  try {
    const xml = await readDocxDocumentXml(bytes);
    if (xml.includes("<!DOCTYPE") || xml.includes("<!ENTITY")) throw invalid();
    const content = xml
      .replace(/<w:tab\b[^>]*\/>/gu, "\t")
      .replace(/<w:br\b[^>]*\/>/gu, "\n")
      .replace(/<\/w:p>/gu, "\n")
      .replace(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/gu, "$1\u0000")
      .split("\u0000")
      .map((part) => decodeXmlText(part.replace(/<[^>]*>/gu, "")))
      .join("")
      .trim();
    if (content.length === 0) throw noText();
    if (hasUnsafeExtractedControl(content)) throw invalid();
    assertExtractedBound(content);
    return content;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalid();
  }
}

function readDocxDocumentXml(bytes: Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(bytes, { lazyEntries: true }, (openError, archive) => {
      if (openError !== null || archive === undefined) {
        reject(invalid());
        return;
      }
      let entryCount = 0;
      let totalUncompressed = 0;
      let settled = false;
      let documentXml: string | undefined;
      let hasContentTypes = false;
      let hasRootRelationships = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        archive.close();
        reject(error instanceof Error ? error : invalid());
      };
      archive.on("error", fail);
      archive.on("entry", (entry: yauzl.Entry) => {
        entryCount += 1;
        totalUncompressed += entry.uncompressedSize;
        if (
          entryCount > DOCX_MAX_ENTRIES ||
          entry.uncompressedSize > DOCX_MAX_ENTRY_BYTES ||
          totalUncompressed > DOCX_MAX_UNCOMPRESSED_BYTES ||
          unsafeArchiveName(entry.fileName) ||
          (entry.generalPurposeBitFlag & 1) !== 0 ||
          (entry.uncompressedSize > 0 && entry.compressedSize === 0) ||
          (entry.compressedSize > 0 &&
            entry.uncompressedSize / entry.compressedSize >
              DOCX_MAX_COMPRESSION_RATIO)
        ) {
          fail(invalid());
          return;
        }
        if (entry.fileName !== "word/document.xml") {
          if (entry.fileName === "[Content_Types].xml") hasContentTypes = true;
          if (entry.fileName === "_rels/.rels") hasRootRelationships = true;
          archive.readEntry();
          return;
        }
        archive.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null || stream === undefined) {
            fail(invalid());
            return;
          }
          const chunks: Buffer[] = [];
          let size = 0;
          stream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > DOCX_MAX_ENTRY_BYTES) {
              stream.destroy(invalid());
              return;
            }
            chunks.push(chunk);
          });
          stream.on("error", fail);
          stream.on("end", () => {
            if (settled) return;
            try {
              documentXml = new TextDecoder("utf-8", { fatal: true }).decode(
                Buffer.concat(chunks),
              );
              archive.readEntry();
            } catch {
              fail(invalid());
            }
          });
        });
      });
      archive.on("end", () => {
        if (settled) return;
        settled = true;
        archive.close();
        if (
          documentXml === undefined ||
          !hasContentTypes ||
          !hasRootRelationships
        ) {
          reject(invalid());
          return;
        }
        resolve(documentXml);
      });
      archive.readEntry();
    });
  });
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_, number: string) =>
      String.fromCodePoint(Number(number)),
    )
    .replace(/&#x([0-9a-f]+);/giu, (_, number: string) =>
      String.fromCodePoint(Number.parseInt(number, 16)),
    )
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

function basenameAcrossPlatforms(filename: string): string {
  return filename.split(/[\\/]/u).at(-1) ?? "";
}

function deriveTitle(filename: string, extension: string): string {
  const raw = filename.slice(
    0,
    Math.max(0, filename.length - extension.length),
  );
  const title = raw.trim();
  if (
    title.length < 1 ||
    title.length > 200 ||
    hasForbiddenControlCharacter(title) ||
    title.includes("\n") ||
    title.includes("\t")
  )
    throw invalid();
  return title;
}

function requireMime(actual: string, allowed: readonly string[]): void {
  if (!allowed.includes(actual.toLowerCase())) throw unsupported();
}

function assertExtractedBound(content: string): void {
  if (Buffer.byteLength(content, "utf8") > KNOWLEDGE_CONTENT_MAX_BYTES)
    throw tooLarge();
}

function hasKnownBinarySignature(bytes: Buffer): boolean {
  return (
    bytes.subarray(0, 2).equals(Buffer.from("MZ")) ||
    bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) ||
    isZip(bytes) ||
    bytes.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))
  );
}

function isZip(bytes: Buffer): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    [0x03, 0x05, 0x07].includes(bytes[2] ?? -1) &&
    [0x04, 0x06, 0x08].includes(bytes[3] ?? -1)
  );
}

function unsafeArchiveName(name: string): boolean {
  return (
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[a-z]:/iu.test(name) ||
    name.split("/").some((part) => part === ".." || part === ".")
  );
}

function hasUnsafeExtractedControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
      (code >= 127 && code <= 159)
    );
  });
}

function unsupported(): AppError {
  return fileError(
    "KNOWLEDGE_FILE_UNSUPPORTED",
    415,
    "Knowledge file type is unsupported",
  );
}

function tooLarge(): AppError {
  return fileError(
    "KNOWLEDGE_FILE_TOO_LARGE",
    413,
    "Knowledge file is too large",
  );
}

function invalid(): AppError {
  return fileError("KNOWLEDGE_FILE_INVALID", 400, "Knowledge file is invalid");
}

function noText(): AppError {
  return fileError(
    "KNOWLEDGE_FILE_NO_TEXT",
    400,
    "Knowledge file contains no usable text",
  );
}

function extractionFailed(): AppError {
  return fileError(
    "KNOWLEDGE_FILE_EXTRACTION_FAILED",
    422,
    "Knowledge file text extraction failed",
  );
}

function fileError(
  code: string,
  httpStatus: number,
  message: string,
): AppError {
  return new AppError({ code, httpStatus, message });
}
