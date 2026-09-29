/**
 * The only thing the app ever says about mail that is not a report: how much
 * of it was checked. No subject, no sender, no content.
 */
export default function OtherMessagesNote({ total, unreadable }: {
  total: number; unreadable: number;
}) {
  return (
    <p className="small muted">
      Only reports are shown in this app. The assistant checks every message to find them,
      but nothing about any other email — subject, sender or content — is shown here.
      {total > 0 && (
        <> {total} other message{total === 1 ? ' was' : 's were'} checked and{' '}
          {total === 1 ? 'is' : 'are'} not shown.</>
      )}
      {unreadable > 0 && (
        <> {unreadable} of {total === 1 ? 'it' : 'them'} carried a PDF, a picture or a private
          Google Sheet that could not be opened. If a department sends its DWR that way, ask
          for the sheet itself, attached or shared as &ldquo;anyone with the link&rdquo;.</>
      )}
    </p>
  );
}
