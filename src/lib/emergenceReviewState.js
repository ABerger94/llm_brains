/** @returns {'pending' | 'approved' | 'rejected'} */
export function emergenceReviewState(event) {
  const rs = String(event?.review_status || '')
    .trim()
    .toLowerCase();
  if (rs === 'approved') return 'approved';
  if (rs === 'rejected') return 'rejected';
  if (rs === 'pending') return 'pending';
  if (event?.reviewed === true) return 'approved';
  return 'pending';
}
