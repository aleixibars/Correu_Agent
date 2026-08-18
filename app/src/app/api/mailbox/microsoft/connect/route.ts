import { auth } from "../../../../../auth";
import { db } from "../../../../../lib/db";
import { createMicrosoftMailboxHandlers } from "../../../../../lib/mailbox/microsoft";

export const { connect: GET } = createMicrosoftMailboxHandlers({ auth, db });
