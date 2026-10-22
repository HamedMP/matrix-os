/** Observed inputs inform internal routing and derived Chat vision capabilities.
 * Existing connection clients accept only these two strict model fields. */
export function projectConnectionModelInputs<T extends { models: readonly { id: string; displayName: string }[] }>(connection: T) {
  return { ...connection, models: connection.models.map(({ id, displayName }) => ({ id, displayName })) };
}
