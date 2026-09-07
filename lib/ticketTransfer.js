export const DEFAULT_TICKET_TRANSFER = {
  alias: 'terzoposto.mp',
  holder: 'Luciano Di Pasquale',
};

function accountTransferName(row) {
  return String(row?.full_name || row?.holder || '').trim();
}

export async function resolveTicketTransfer(client, rental) {
  const alias = String(rental?.transfer_alias || '').trim();
  const storedHolder = String(rental?.transfer_holder || '').trim();

  if (client && alias) {
    const found = await client.query(
      `SELECT full_name, holder
       FROM mercado_pago_accounts
       WHERE id <> 'efectivo'
         AND COALESCE(kind, 'mercadopago') = 'mercadopago'
         AND lower(btrim(alias)) = lower(btrim($1))
       LIMIT 1`,
      [alias],
    );
    const name = accountTransferName(found.rows[0]);
    if (name) {
      return { alias, holder: name };
    }
  }

  return {
    alias: alias || DEFAULT_TICKET_TRANSFER.alias,
    holder: storedHolder || DEFAULT_TICKET_TRANSFER.holder,
  };
}

export async function resolveTicketTransferAccountId(client, rental) {
  const alias = String(rental?.transfer_alias || '').trim();
  if (!client || !alias) return null;
  const found = await client.query(
    `SELECT id FROM mercado_pago_accounts
     WHERE id <> 'efectivo'
       AND COALESCE(kind, 'mercadopago') = 'mercadopago'
       AND lower(btrim(alias)) = lower(btrim($1))
     LIMIT 1`,
    [alias],
  );
  return found.rows[0]?.id || null;
}
