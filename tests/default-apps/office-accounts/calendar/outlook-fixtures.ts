/** Hand-written Microsoft Graph v1.0 calendar replies, shaped like the live provider's JSON. */

export const OUTLOOK_CALENDARS_PAGE_1 = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('owner%40contoso.com')/calendars",
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars?$top=100&$skip=100",
  value: [
    {
      id: "AAMkADdefault-cal_1=",
      name: "Calendar",
      color: "auto",
      hexColor: "",
      isDefaultCalendar: true,
      changeKey: "nfZyf7VcrEKLNoU37KWlkQAAA0x0+w==",
      canShare: true,
      canViewPrivateItems: true,
      canEdit: true,
      allowedOnlineMeetingProviders: ["teamsForBusiness"],
      defaultOnlineMeetingProvider: "teamsForBusiness",
      isRemovable: false,
      owner: { name: "Owner Person", address: "owner@contoso.com" },
    },
    {
      id: "AAMkADholidays_2=",
      name: "United States holidays",
      color: "lightGreen",
      hexColor: "",
      isDefaultCalendar: false,
      canEdit: false,
      owner: { name: "Owner Person", address: "owner@contoso.com" },
    },
  ],
};

export const OUTLOOK_CALENDARS_PAGE_2 = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('owner%40contoso.com')/calendars",
  value: [
    {
      id: "AAMkADteam_3=",
      name: "Team",
      color: "auto",
      hexColor: "#E3008C",
      isDefaultCalendar: false,
      canEdit: true,
      owner: { name: "Team", address: "team@contoso.com" },
    },
  ],
};

export const OUTLOOK_TIMED_EVENT = {
  "@odata.etag": "W/\"DwAAABYAAAA=\"",
  id: "AAMkEvt_quarterly=",
  createdDateTime: "2026-11-01T10:00:00.1234567Z",
  subject: "Quarterly planning",
  bodyPreview: "Agenda Budget",
  body: {
    contentType: "html",
    content: "<html><head><style>p{color:red}</style></head><body><p>Agenda</p><script>alert(1)</script><ul><li>Budget &lt;Q4&gt;</li></ul></body></html>",
  },
  start: { dateTime: "2026-11-23T14:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-23T15:30:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "Pacific Standard Time",
  originalEndTimeZone: "Pacific Standard Time",
  isAllDay: false,
  isCancelled: false,
  isOrganizer: true,
  showAs: "busy",
  type: "singleInstance",
  seriesMasterId: null,
  recurrence: null,
  categories: ["Blue category"],
  location: { displayName: "Conf room A", locationType: "default" },
  attendees: [
    { type: "required", status: { response: "accepted", time: "2026-11-02T08:00:00Z" }, emailAddress: { name: "Ana Lima", address: "ana@contoso.com" } },
    { type: "optional", status: { response: "none", time: "0001-01-01T00:00:00Z" }, emailAddress: { name: "Bo", address: "Bo@Contoso.com" } },
    { type: "resource", status: { response: "accepted", time: "2026-11-02T08:00:00Z" }, emailAddress: { name: "Conf room A", address: "confa@contoso.com" } },
  ],
  organizer: { emailAddress: { name: "Owner Person", address: "owner@contoso.com" } },
  responseStatus: { response: "organizer", time: "0001-01-01T00:00:00Z" },
  isOnlineMeeting: true,
  onlineMeetingProvider: "teamsForBusiness",
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0" },
};

export const OUTLOOK_ALL_DAY_FLOATING = {
  id: "AAMkAllDay_offsite=",
  subject: "Offsite",
  bodyPreview: "",
  body: { contentType: "text", content: "" },
  isAllDay: true,
  isCancelled: false,
  isOrganizer: true,
  start: { dateTime: "2026-11-26T00:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-28T00:00:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "W. Europe Standard Time",
  originalEndTimeZone: "W. Europe Standard Time",
  location: { displayName: "" },
  attendees: [],
  organizer: { emailAddress: { name: "Owner Person", address: "owner@contoso.com" } },
  responseStatus: { response: "organizer" },
  type: "singleInstance",
};

/** An all-day event that came back as the UTC moments of Berlin midnights. */
export const OUTLOOK_ALL_DAY_SHIFTED = {
  ...OUTLOOK_ALL_DAY_FLOATING,
  id: "AAMkAllDay_shifted=",
  subject: "Public holiday",
  start: { dateTime: "2026-11-24T23:00:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-25T23:00:00.0000000", timeZone: "UTC" },
};

export const OUTLOOK_OCCURRENCE = {
  id: "AAMkOcc_standup_1124=",
  subject: "Standup",
  bodyPreview: "Daily sync",
  body: { contentType: "text", content: "Daily sync\r\nBring blockers" },
  start: { dateTime: "2026-11-24T08:30:00.0000000", timeZone: "UTC" },
  end: { dateTime: "2026-11-24T08:45:00.0000000", timeZone: "UTC" },
  originalStartTimeZone: "GMT Standard Time",
  isAllDay: false,
  isCancelled: false,
  isOrganizer: false,
  type: "occurrence",
  seriesMasterId: "AAMkSeries_standup=",
  recurrence: null,
  location: { displayName: "" },
  responseStatus: { response: "tentativelyAccepted", time: "2026-11-20T08:00:00Z" },
  organizer: { emailAddress: { name: "Team Lead", address: "lead@contoso.com" } },
  attendees: [
    { type: "required", status: { response: "accepted" }, emailAddress: { name: "Ana Lima", address: "ana@contoso.com" } },
    { type: "required", status: { response: "tentativelyAccepted" }, emailAddress: { name: "Owner Person", address: "owner@contoso.com" } },
  ],
  isOnlineMeeting: false,
  onlineMeeting: null,
};

export const OUTLOOK_CANCELLED = { ...OUTLOOK_OCCURRENCE, id: "AAMkCancelled=", subject: "Canceled: Old sync", isCancelled: true, seriesMasterId: null, type: "singleInstance" };

export const OUTLOOK_EVENTS_PAGE_1 = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('owner')/calendars('AAMkADdefault-cal_1%3D')/calendarView",
  "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/calendars/AAMkADdefault-cal_1=/calendarView?startDateTime=2026-11-22T23%3a00%3a00Z&endDateTime=2026-11-29T23%3a00%3a00Z&%24top=100&%24skip=100",
  value: [OUTLOOK_OCCURRENCE, OUTLOOK_TIMED_EVENT, OUTLOOK_CANCELLED],
};

export const OUTLOOK_EVENTS_PAGE_2 = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#users('owner')/calendars('AAMkADdefault-cal_1%3D')/calendarView",
  value: [OUTLOOK_ALL_DAY_FLOATING, OUTLOOK_ALL_DAY_SHIFTED],
};

/** The series master the provider returns after a weekly create. */
export const OUTLOOK_CREATED_SERIES = {
  id: "AAMkNewSeries=",
  subject: "Planning",
  bodyPreview: "Bring numbers",
  start: { dateTime: "2026-11-23T09:00:00.0000000", timeZone: "Pacific Standard Time" },
  end: { dateTime: "2026-11-23T10:00:00.0000000", timeZone: "Pacific Standard Time" },
  originalStartTimeZone: "Pacific Standard Time",
  isAllDay: false,
  isOrganizer: true,
  type: "seriesMaster",
  seriesMasterId: null,
  location: { displayName: "HQ" },
  responseStatus: { response: "organizer" },
  organizer: { emailAddress: { name: "Owner Person", address: "owner@contoso.com" } },
  attendees: [{ type: "required", status: { response: "none" }, emailAddress: { name: "Ana Lima", address: "ana@contoso.com" } }],
  recurrence: {
    pattern: { type: "weekly", interval: 2, month: 0, dayOfMonth: 0, daysOfWeek: ["monday", "wednesday"], firstDayOfWeek: "sunday", index: "first" },
    range: { type: "numbered", startDate: "2026-11-23", endDate: "0001-01-01", recurrenceTimeZone: "Pacific Standard Time", numberOfOccurrences: 10 },
  },
  isOnlineMeeting: true,
  onlineMeetingProvider: "teamsForBusiness",
  onlineMeeting: { joinUrl: "https://teams.microsoft.com/l/meetup-join/19%3anew" },
};

export const OUTLOOK_SCHEDULE = {
  "@odata.context": "https://graph.microsoft.com/v1.0/$metadata#Collection(microsoft.graph.scheduleInformation)",
  value: [
    {
      scheduleId: "ana@contoso.com",
      availabilityView: "0022200",
      scheduleItems: [
        { isPrivate: false, status: "busy", subject: "Private thing", location: "", start: { dateTime: "2026-11-23T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T10:00:00.0000000", timeZone: "UTC" } },
        { isPrivate: false, status: "busy", start: { dateTime: "2026-11-23T09:30:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T10:30:00.0000000", timeZone: "UTC" } },
        { isPrivate: false, status: "tentative", start: { dateTime: "2026-11-23T11:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T11:30:00.0000000", timeZone: "UTC" } },
        { isPrivate: false, status: "oof", start: { dateTime: "2026-11-23T13:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T18:00:00.0000000", timeZone: "UTC" } },
        { isPrivate: false, status: "workingElsewhere", start: { dateTime: "2026-11-23T07:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T08:00:00.0000000", timeZone: "UTC" } },
        { isPrivate: false, status: "free", start: { dateTime: "2026-11-23T19:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-11-23T20:00:00.0000000", timeZone: "UTC" } },
      ],
      workingHours: { daysOfWeek: ["monday"], startTime: "08:00:00.0000000", endTime: "17:00:00.0000000", timeZone: { name: "Pacific Standard Time" } },
    },
    {
      scheduleId: "ext@fabrikam.com",
      availabilityView: "",
      scheduleItems: [],
      error: { message: "Mailbox ext@fabrikam.com could not be found in tenant 1234", responseCode: "error" },
    },
  ],
};
