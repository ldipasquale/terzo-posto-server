/**
 * Emisión de factura C (monotributo) contra ARCA.
 * Cada socio usa su CUIT: ARCA_LUCHO_TAX_ID, ARCA_BACHI_TAX_ID, ARCA_LULI_TAX_ID,
 * y el certificado y la clave con el mismo prefijo.
 * La emisión es siempre en producción.
 */
import os from 'node:os';
import path from 'node:path';

const PARTNERS = ['Lucho', 'Bachi', 'Luli'];
const BLOCKED_ACTIVITY_IDS = new Set([620100]);

const ISSUER_DETAILS = {
  Lucho: {
    legalName: 'Luciano Di Pasquale',
    address: 'Alvarez Julian 958 - Ciudad de Buenos Aires',
  },
};

const clients = new Map();
const activitiesCache = new Map();
const salesPointCache = new Map();

export function partnerFromName(name) {
  if (!name) return null;
  const normalized = String(name).trim().toLowerCase();
  const exact = PARTNERS.find(
    (partner) => partner.toLowerCase() === normalized,
  );
  if (exact) return exact;
  return (
    PARTNERS.find((partner) => normalized.includes(partner.toLowerCase())) ??
    null
  );
}

function readEnv(name) {
  const value = process.env[name];
  if (value == null) return '';
  const trimmed = String(value).trim();
  return trimmed.includes('\\n') ? trimmed.replace(/\\n/g, '\n') : trimmed;
}

function partnerCredentials(partner) {
  const prefix = `ARCA_${partner.toUpperCase()}`;
  const fields = {
    taxId: `${prefix}_TAX_ID`,
    certificatePem: `${prefix}_CERTIFICATE_PEM`,
    privateKeyPem: `${prefix}_PRIVATE_KEY_PEM`,
  };
  const config = {
    taxId: readEnv(fields.taxId),
    certificatePem: readEnv(fields.certificatePem),
    privateKeyPem: readEnv(fields.privateKeyPem),
  };
  const missing = Object.entries(fields)
    .filter(([key]) => !config[key])
    .map(([, envName]) => envName);
  if (missing.length > 0) {
    const err = new Error(
      `Faltan credenciales de ${partner}: ${missing.join(', ')}`,
    );
    err.statusCode = 500;
    throw err;
  }
  return config;
}

export function hasInvoiceCredentials(partner) {
  const canonical = partnerFromName(partner);
  if (!canonical) return false;
  const prefix = `ARCA_${canonical.toUpperCase()}`;
  return ['TAX_ID', 'CERTIFICATE_PEM', 'PRIVATE_KEY_PEM'].every(
    (suffix) => readEnv(`${prefix}_${suffix}`) !== '',
  );
}

export function invoiceIssuers() {
  return Object.fromEntries(
    PARTNERS.map((partner) => [partner, hasInvoiceCredentials(partner)]),
  );
}

export function issuerProfile(partner) {
  const canonical = partnerFromName(partner);
  if (!canonical) return null;
  const details = ISSUER_DETAILS[canonical] ?? { legalName: canonical };
  let taxId = null;
  try {
    taxId = partnerCredentials(canonical).taxId;
  } catch {
    taxId = null;
  }
  return {
    legalName: details.legalName,
    address: details.address ?? null,
    taxId,
    issuerCondition: 'Responsable Monotributo',
  };
}

function getArcaClient(partner) {
  const cacheKey = partner;
  let pending = clients.get(cacheKey);
  if (!pending) {
    const credentials = partnerCredentials(partner);
    pending = import('facturas')
      .then(({ createArcaClient, createFileStore }) =>
        createArcaClient({
          ...credentials,
          environment: 'production',
          store: createFileStore(path.join(os.tmpdir(), 'facturas-production')),
        }),
      )
      .catch((error) => {
        clients.delete(cacheKey);
        throw error;
      });
    clients.set(cacheKey, pending);
  }
  return pending;
}

const RECEIVER_CONDITION_LABELS = {
  responsable_inscripto: 'Responsable Inscripto',
  monotributo: 'Responsable Monotributo',
  exento: 'Exento',
  no_alcanzado: 'No Alcanzado',
  consumidor_final: 'Consumidor Final',
};

function pesosToCentavos(amount) {
  const pesos = Number(amount);
  if (!Number.isFinite(pesos) || pesos <= 0) {
    const err = new Error('El monto no se puede facturar');
    err.statusCode = 400;
    throw err;
  }
  return Math.round(pesos * 100);
}

export function parseReceiverTaxId(raw) {
  if (raw == null || String(raw).trim() === '') return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!isValidCuit(digits)) {
    const err = new Error('El CUIT no es válido');
    err.statusCode = 400;
    throw err;
  }
  return digits;
}

function isValidCuit(digits) {
  if (!/^\d{11}$/.test(digits)) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  const sum = weights.reduce(
    (total, weight, index) => total + weight * Number(digits[index]),
    0,
  );
  let verifier = 11 - (sum % 11);
  if (verifier === 11) verifier = 0;
  else if (verifier === 10) verifier = 9;
  return verifier === Number(digits[10]);
}

async function resolveReceiver(arca, cuit) {
  if (!cuit) {
    return {
      to: { condition: 'consumidor_final' },
      receiverName: null,
      receiverVatCondition: null,
      receiverTaxId: null,
      receiverResolved: false,
    };
  }

  let details = null;
  try {
    details = await arca.padron.getTaxpayerDetails(cuit);
  } catch (error) {
    console.error('Padron lookup failed:', error?.message || error);
  }

  const condition = details?.condition ?? 'consumidor_final';
  return {
    to: { condition, cuit },
    receiverName: details?.name ?? null,
    receiverVatCondition: RECEIVER_CONDITION_LABELS[condition] ?? null,
    receiverTaxId: cuit,
    receiverResolved: Boolean(details?.condition),
  };
}

async function resolveSalesPoint(partner, arca) {
  const cached = salesPointCache.get(partner);
  if (cached) return cached;

  let points;
  try {
    points = await arca.wsfe.getSalesPoints();
  } catch (error) {
    console.error('Sales points lookup failed:', error?.message || error);
    const err = new Error('No se pudieron consultar los puntos de venta');
    err.statusCode = 502;
    throw err;
  }

  const enabled = points.filter(
    (point) =>
      !point.blocked &&
      !point.deletedAt &&
      Number.isInteger(point.number) &&
      point.number > 0,
  );
  if (enabled.length !== 1) {
    const err = new Error(
      enabled.length === 0
        ? 'No hay un punto de venta habilitado para facturación electrónica'
        : `Hay más de un punto de venta habilitado: ${enabled.map((point) => point.number).join(', ')}`,
    );
    err.statusCode = 500;
    throw err;
  }

  salesPointCache.set(partner, enabled[0].number);
  return enabled[0].number;
}

async function invoiceInput({
  arca,
  partner,
  amountPesos,
  reason,
  receiverTaxId,
  activityId,
}) {
  const receiver = await resolveReceiver(arca, receiverTaxId);
  const salesPoint = await resolveSalesPoint(partner, arca);
  const description = String(reason || '')
    .trim()
    .slice(0, 200);
  return {
    receiver,
    input: {
      issuer: 'monotributo',
      salesPoint,
      to: receiver.to,
      ...(activityId ? { activities: [{ id: activityId }] } : {}),
      items: [
        {
          amount: pesosToCentavos(amountPesos),
          ...(description ? { description } : {}),
        },
      ],
    },
  };
}

export async function listIssuerActivities(partner) {
  const { partner: canonical, arca } = await clientForPartner(partner);
  const cached = activitiesCache.get(canonical);
  if (cached) return cached;

  let activities;
  try {
    activities = await arca.wsfe.getActivities();
  } catch (error) {
    const code = String(error?.serviceCode ?? error?.issues?.[0]?.code ?? '');
    if (code === '602') return [];
    console.error('Invoice activities lookup failed:', error?.message || error);
    const err = new Error('No se pudieron consultar las actividades');
    err.statusCode = 502;
    throw err;
  }

  const list = activities
    .filter(
      (activity) =>
        Number.isInteger(activity.id) &&
        activity.id > 0 &&
        !BLOCKED_ACTIVITY_IDS.has(activity.id),
    )
    .sort(
      (left, right) =>
        left.order - right.order ||
        left.description.localeCompare(right.description, 'es'),
    )
    .map(({ id, description, order }) => ({ id, description, order }));
  if (list.length > 0) activitiesCache.set(canonical, list);
  return list;
}

export async function resolveActivityId(partner, raw) {
  const activities = await listIssuerActivities(partner);
  if (raw == null || raw === '') {
    if (activities.length === 0) return null;
    const err = new Error('Elegí una actividad');
    err.statusCode = 400;
    throw err;
  }
  const id = Number(raw);
  if (!activities.some((activity) => activity.id === id)) {
    const err = new Error('La actividad no está habilitada');
    err.statusCode = 400;
    throw err;
  }
  return id;
}

async function clientForPartner(partner) {
  const canonical = partnerFromName(partner);
  if (!canonical) {
    const err = new Error('No se puede facturar para este socio');
    err.statusCode = 400;
    throw err;
  }
  try {
    return { partner: canonical, arca: await getArcaClient(canonical) };
  } catch (error) {
    if (error?.statusCode) throw error;
    const err = new Error(
      error?.code === 'ERR_MODULE_NOT_FOUND'
        ? 'No está instalado el facturador'
        : 'El facturador no pudo iniciarse. Revisá Node 22 y las variables ARCA.',
    );
    err.statusCode = 500;
    throw err;
  }
}

export async function previewMonotributoInvoice({
  partner,
  amountPesos,
  reason,
  receiverTaxId = null,
}) {
  const { partner: canonical, arca } = await clientForPartner(partner);
  const { receiver, input } = await invoiceInput({
    arca,
    partner: canonical,
    amountPesos,
    reason,
    receiverTaxId,
  });
  let preview;
  try {
    preview = arca.preview(input);
  } catch (error) {
    const err = new Error(error?.message || 'No se pudo armar la factura');
    err.statusCode = 400;
    throw err;
  }
  const details = ISSUER_DETAILS[canonical] ?? { legalName: canonical };
  return {
    partner: canonical,
    legalName: details.legalName,
    address: details.address ?? null,
    taxId: partnerCredentials(canonical).taxId,
    issuerCondition: 'Responsable Monotributo',
    voucherClass: preview.voucherClass,
    voucherType: preview.voucherType,
    salesPoint: input.salesPoint,
    date: preview.date,
    receiverName: receiver.receiverName,
    receiverVatCondition: receiver.receiverVatCondition,
    receiverTaxId: receiver.receiverTaxId,
    receiverResolved: receiver.receiverResolved,
    saleCondition: 'Otros medios de pago electrónico',
    description: String(reason || '').trim(),
    quantity: 1,
    amount: preview.amounts.sentTotal / 100,
  };
}

export async function issueMonotributoInvoice({
  partner,
  amountPesos,
  reason,
  idempotencyKey,
  receiverTaxId = null,
  activityId = null,
}) {
  const { arca } = await clientForPartner(partner);
  const { receiver, input } = await invoiceInput({
    arca,
    partner,
    amountPesos,
    reason,
    receiverTaxId,
    activityId,
  });
  const factura = await arca.issue(input, { idempotencyKey });
  return { ...factura, receiver };
}

export function describeIssueFailure(factura) {
  if (factura?.kind === 'rejected') {
    const message = factura.issues?.map((issue) => issue.message).find(Boolean);
    return message || 'ARCA rechazó la factura';
  }
  if (factura?.kind === 'indeterminate') {
    return 'ARCA no confirmó la factura. Reintentá el mismo ingreso.';
  }
  if (factura?.kind === 'conflict') {
    return 'Hay otro comprobante en el número reservado.';
  }
  return 'No se pudo emitir la factura';
}
