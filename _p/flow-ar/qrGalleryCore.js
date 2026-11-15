export function titleCaseIdentifier(identifier) {
  return String(identifier || "")
    .trim()
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/(^|\s)([a-z])/g, (_, spacing, letter) => `${spacing}${letter.toUpperCase()}`);
}

export function caseDisplayLabel({ definition, referenceLabel }) {
  for (const candidate of [definition?.label, referenceLabel]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const label = candidate.trim();
    if (label === definition.id || /^[a-z][A-Za-z\d_-]*$/.test(label)) {
      return titleCaseIdentifier(label);
    }
    return label;
  }
  return titleCaseIdentifier(definition?.id) || "Case";
}

export function caseAnchorAlt(anchor, displayLabel, caseId) {
  if (typeof anchor?.alt !== "string" || !anchor.alt.trim()) {
    return `${displayLabel}のQR / image anchor`;
  }
  const authoredAlt = caseId && caseId !== displayLabel
    ? anchor.alt.trim().split(caseId).join(displayLabel)
    : anchor.alt.trim();
  return authoredAlt.toLocaleLowerCase().includes(displayLabel.toLocaleLowerCase())
    ? authoredAlt
    : `${displayLabel}: ${authoredAlt}`;
}

function validReference(reference) {
  return reference
    && /^[A-Za-z][A-Za-z0-9-]*$/.test(String(reference.id || ""))
    && typeof reference.manifest === "string"
    && reference.manifest.trim();
}

export function collectCaseReferences(catalog) {
  const references = [];
  for (const category of catalog?.categories || []) {
    for (const reference of category?.case || []) {
      if (!validReference(reference)) continue;
      references.push({
        ...reference,
        categoryLabel: String(category.label || "Simulation")
      });
    }
  }
  for (const reference of catalog?.auxiliary || []) {
    if (!validReference(reference)) continue;
    references.push({
      ...reference,
      categoryLabel: String(reference.label || "Other")
    });
  }
  return [...new Map(references.map((reference) => [reference.id, reference])).values()];
}

export function resolveCaseManifestUrl(reference, catalogUrl) {
  if (!validReference(reference)) throw new Error("Invalid case reference");
  const catalog = catalogUrl instanceof URL ? catalogUrl : new URL(catalogUrl);
  const root = new URL("./", catalog);
  const manifest = new URL(reference.manifest, catalog);
  if (
    manifest.origin !== root.origin
    || manifest.username
    || manifest.password
    || !manifest.pathname.startsWith(root.pathname)
  ) {
    throw new Error(`Case manifest is outside the runtime catalog: ${reference.id}`);
  }
  return manifest;
}

export function validatedCaseRecord(definition, reference) {
  if (
    definition?.schemaVersion !== 1
    || definition.id !== reference.id
    || typeof definition.assetRoot !== "string"
  ) {
    throw new Error(`Invalid case manifest: ${reference.id}`);
  }
  const physicalWidthCm = Number(definition.anchor?.physicalWidthCm);
  if (
    typeof definition.anchor?.image !== "string"
    || !definition.anchor.image
    || !Number.isFinite(physicalWidthCm)
    || physicalWidthCm <= 0
  ) {
    throw new Error(`Case has no printable QR anchor: ${reference.id}`);
  }
  return { definition, reference, physicalWidthCm };
}
