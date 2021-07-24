import fs from "fs";
import path from "path";
import util from "util";
import { readDefaultCodeTranslationMessages } from "@docusaurus/utils";
import {
  LoadContext,
  OptionValidationContext,
  Plugin,
} from "@docusaurus/types";
import lunr from "lunr";
import { Joi } from "@docusaurus/utils-validation";

const readFileAsync = util.promisify(fs.readFile);
const writeFileAsync = util.promisify(fs.writeFile);

import { html2text, getDocVersion } from "./parse";
import logger from "./logger";

// FIXME: Duplicated in src/theme/SearchBar/util.js
function urlMatchesPrefix(url: string, prefix: string) {
  if (prefix.endsWith("/")) {
    throw new Error(`prefix must not end with a /. This is a bug.`);
  }
  return prefix === "" || url === prefix || url.startsWith(`${prefix}/`);
}

type MyOptions = {
  blogRouteBasePath: string;
  docsRouteBasePath: string;
  indexPages: boolean;
  indexBlog: boolean;
  indexDocs: boolean;
  language: string | string[];
  indexDocSidebarParentCategories: number;
  lunr: {
    tokenizerSeparator?: string;
  };
  style?: "none";
};

const languageSchema = Joi.string().valid(
  "ar",
  "da",
  "de",
  "en",
  "es",
  "fi",
  "fr",
  "hi",
  "hu",
  "it",
  "ja",
  "nl",
  "no",
  "pt",
  "ro",
  "ru",
  "sv",
  "th",
  "tr",
  "vi"
);

const basePathSchema = Joi.string().pattern(/^\//);

const optionsSchema = Joi.object({
  indexDocs: Joi.boolean().default(true),
  docsRouteBasePath: basePathSchema.default("/docs"),
  indexDocSidebarParentCategories: Joi.number()
    .integer()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER)
    .default(0),

  indexBlog: Joi.boolean().default(true),
  blogRouteBasePath: basePathSchema.default("/blog"),

  indexPages: Joi.boolean().default(false),

  language: Joi.alternatives(
    languageSchema,
    Joi.array().items(languageSchema)
  ).default("en"),

  style: Joi.string().valid("none"),

  lunr: Joi.object({
    tokenizerSeparator: Joi.object().regex(),
  }).default(),
});

export default function cmfcmfDocusaurusSearchLocal(
  context: LoadContext,
  options: MyOptions
): Plugin<unknown> {
  let {
    language,
    blogRouteBasePath: blogBasePath,
    docsRouteBasePath: docsBasePath,
    indexDocSidebarParentCategories,
    indexBlog,
    indexDocs,
    indexPages,
    style,
    lunr: { tokenizerSeparator: lunrTokenizerSeparator },
  } = options;

  if (lunrTokenizerSeparator) {
    // @ts-expect-error
    lunr.tokenizer.separator = lunrTokenizerSeparator;
  }

  if (Array.isArray(language) && language.length === 1) {
    language = language[0];
  }

  blogBasePath = blogBasePath.substr(1);
  docsBasePath = docsBasePath.substr(1);

  const docsDir = path.resolve(context.siteDir, "docs");
  let docVersions = [];
  let useDocVersioning = false;
  if (!fs.existsSync(docsDir)) {
    logger.info(
      `Skipping search index generation for documentation because directory ${docsDir} does not exist.`
    );
  } else {
    const versionsPath = path.join(docsDir, "..", "versions.json");
    if (fs.existsSync(versionsPath)) {
      useDocVersioning = true;
      docVersions = [
        ...JSON.parse(fs.readFileSync(versionsPath, "utf-8")),
        "next",
      ];
      logger.info(
        `The following documentation versions were detected: ${docVersions.join(
          ", "
        )}`
      );
    } else {
      logger.info(
        `The documentation is not versioned (${versionsPath} does not exist).`
      );
    }
  }

  let generated =
    "// THIS FILE IS AUTOGENERATED\n" + "// DO NOT EDIT THIS FILE!\n\n";

  if (style !== "none") {
    generated += 'require("@algolia/autocomplete-theme-classic");\n';
    generated += 'import "./index.css";\n';
  }

  generated += 'import * as lunr from "lunr";\n';

  function handleLangCode(code: string) {
    let generated = "";

    if (code === "jp") {
      throw new Error(`Language "jp" is deprecated, please use "ja".`);
    }

    if (code === "ja") {
      require("lunr-languages/tinyseg")(lunr);
      generated += `require("lunr-languages/tinyseg")(lunr);\n`;
    } else if (code === "th" || code === "hi") {
      // @ts-expect-error see
      // https://github.com/MihaiValentin/lunr-languages/blob/a62fec97fb1a62bb4581c9b69a5ddedf62f8f62f/test/VersionsAndLanguagesTest.js#L110-L112
      lunr.wordcut = require("lunr-languages/wordcut");
      generated += `lunr.wordcut = require("lunr-languages/wordcut");\n`;
    }
    require(`lunr-languages/lunr.${code}`)(lunr);
    generated += `require("lunr-languages/lunr.${code}")(lunr);\n`;

    return generated;
  }

  if (language !== "en") {
    require("lunr-languages/lunr.stemmer.support")(lunr);
    generated += 'require("lunr-languages/lunr.stemmer.support")(lunr);\n';
    if (Array.isArray(language)) {
      language
        .filter((code) => code !== "en")
        .forEach((code) => {
          generated += handleLangCode(code);
        });
      require("lunr-languages/lunr.multi")(lunr);
      generated += `require("lunr-languages/lunr.multi")(lunr);\n`;
    } else {
      generated += handleLangCode(language);
    }
  }
  if (language === "ja" || language === "th") {
    if (lunrTokenizerSeparator) {
      throw new Error(
        "The lunr.tokenizerSeparator option is not supported for 'ja' and 'th' languages."
      );
    }
    generated += `\
export const tokenize = (input) => lunr[${JSON.stringify(
      language
    )}].tokenizer(input)
  .map(token => token${language === "th" ? "" : ".str"});\n`;
  } else {
    if (lunrTokenizerSeparator) {
      generated += `\
lunr.tokenizer.separator = ${lunrTokenizerSeparator.toString()};\n`;
    }
    generated += `\
export const tokenize = (input) => lunr.tokenizer(input)
  .map(token => token.str);\n`;
  }
  generated += `export const mylunr = lunr;\n`;
  generated += `export const docsBasePath = ${JSON.stringify(docsBasePath)};\n`;
  generated += `export const blogBasePath = ${JSON.stringify(blogBasePath)};\n`;
  generated += `export const indexDocSidebarParentCategories = ${JSON.stringify(
    indexDocSidebarParentCategories
  )};\n`;

  ["src", "lib"].forEach((folder) => {
    const generatedPath = path.join(
      __dirname,
      "..",
      "..",
      folder,
      "client",
      "theme",
      "SearchBar",
      "generated.js"
    );
    fs.writeFileSync(generatedPath, generated);
  });

  return {
    name: "@cmfcmf/docusaurus-search-local",
    getThemePath() {
      return path.resolve(__dirname, "..", "..", "lib", "client", "theme");
    },
    getTypeScriptThemePath() {
      return path.resolve(__dirname, "..", "..", "src", "client", "theme");
    },
    getDefaultCodeTranslationMessages: () =>
      readDefaultCodeTranslationMessages({
        dirPath: path.resolve(__dirname, "..", "..", "codeTranslations"),
        locale: context.i18n.currentLocale,
      }),
    async postBuild({
      routesPaths = [],
      outDir,
      baseUrl,
      siteConfig: { trailingSlash },
    }) {
      logger.info("Gathering documents");

      const data = routesPaths
        .flatMap((url) => {
          const route = url.substr(baseUrl.length);
          if (!url.startsWith(baseUrl)) {
            throw new Error(
              `The route must start with the baseUrl ${baseUrl}, but was ${route}. This is a bug, please report it.`
            );
          }
          if (route === "404.html") {
            // Do not index error page.
            return [];
          }
          if (indexBlog && urlMatchesPrefix(route, blogBasePath)) {
            if (
              route === blogBasePath ||
              urlMatchesPrefix(route, `${blogBasePath}/tags`)
            ) {
              // Do not index list of blog posts and tags filter pages
              return [];
            }
            return { route, url, type: "blog" as const };
          }
          if (indexDocs && urlMatchesPrefix(route, docsBasePath)) {
            return { route, url, type: "docs" as const };
          }
          if (indexPages) {
            return { route, url, type: "page" as const };
          }
          return [];
        })
        .map(({ route, url, type }) => {
          const file =
            trailingSlash === false
              ? path.join(outDir, `${route}.html`)
              : path.join(outDir, route, "index.html");
          return {
            file,
            url,
            type,
          };
        });

      logger.info("Parsing documents");

      // Give every index entry a unique id so that the index does not need to store long URLs.
      let nextDocId = 1;
      const documents = (
        await Promise.all(
          data.map(async ({ file, url, type }) => {
            logger.debug(`Parsing ${type} file ${file}`, { url });
            const html = await readFileAsync(file, { encoding: "utf8" });
            const { pageTitle, sections, docSidebarParentCategories } =
              html2text(html, type, url);
            const docVersion = getDocVersion(html);

            return sections.map((section) => ({
              id: nextDocId++,
              pageTitle,
              pageRoute: url,
              sectionRoute: url + section.hash,
              sectionTitle: section.title,
              sectionContent: section.content,
              docVersion,
              docSidebarParentCategories,
            }));
          })
        )
      ).flat();

      logger.info("Building index");

      const index = lunr(function () {
        if (language !== "en") {
          if (Array.isArray(language)) {
            // @ts-expect-error
            this.use(lunr.multiLanguage(...language));
          } else {
            // @ts-expect-error
            this.use(lunr[language]);
          }
        }
        this.ref("id");
        this.field("title");
        this.field("content");
        if (useDocVersioning) {
          this.field("version");
        }
        if (indexDocSidebarParentCategories > 0) {
          this.field("sidebarParentCategories");
        }
        const that = this;
        documents.forEach(function ({
          id,
          sectionTitle,
          sectionContent,
          docVersion,
          docSidebarParentCategories,
        }) {
          let sidebarParentCategories;
          if (
            indexDocSidebarParentCategories > 0 &&
            docSidebarParentCategories
          ) {
            sidebarParentCategories = docSidebarParentCategories
              .reverse()
              .slice(0, indexDocSidebarParentCategories)
              .join(" ");
          }

          that.add({
            id: id.toString(), // the ref must be a string
            title: sectionTitle,
            content: sectionContent,
            version: docVersion, // undefined for pages and blog
            sidebarParentCategories: sidebarParentCategories,
          });
        });
      });

      logger.info("Writing index to disk");

      await writeFileAsync(
        path.join(outDir, "search-index.json"),
        JSON.stringify({
          documents: documents.map(
            ({ id, pageTitle, sectionTitle, sectionRoute, docVersion }) => ({
              id,
              pageTitle,
              sectionTitle,
              sectionRoute,
              // Only include docVersion metadata if versioning is used
              docVersion: useDocVersioning ? docVersion : undefined,
            })
          ),
          index,
        }),
        { encoding: "utf8" }
      );

      logger.info("Index written to disk, success!");
    },
  };
}

export function validateOptions({
  options,
  validate,
}: OptionValidationContext<MyOptions>) {
  return validate(optionsSchema, options);
}
