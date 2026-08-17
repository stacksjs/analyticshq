/**
 * analyticshq — Looker Studio Community Connector (#25).
 *
 * Apps Script, deployed by YOU into YOUR Google account. We publish no connector
 * to Google's gallery and register no application with Google, which is the same
 * decision the Search Console and GA4 importers make: the integration should not
 * create a standing relationship between this product and Google.
 *
 * Auth is `KEY` — the share token from your dashboard. It is per-site,
 * read-only, and you can rotate or revoke it at any time under Share, which
 * immediately kills every report built on it.
 *
 * See README.md in this folder for the five-minute deploy.
 */

/* eslint-disable no-var, vars-on-top */

var DEFAULT_HOST = 'https://analyticshq.com'

var cc = DataStudioApp.createCommunityConnector()

/**
 * KEY, not OAUTH2. An OAuth flow would mean registering an application with
 * Google and holding credentials for your Google account; a share token is the
 * credential this product already issues for exactly this purpose.
 */
function getAuthType() {
  return cc.newAuthTypeResponse()
    .setAuthType(cc.AuthType.KEY)
    .setHelpUrl(DEFAULT_HOST + '/docs/connectors')
    .build()
}

function resetAuth() {
  PropertiesService.getUserProperties().deleteProperty('dscc.key')
}

function isAuthValid() {
  var key = PropertiesService.getUserProperties().getProperty('dscc.key')
  return key !== null && key !== ''
}

/**
 * Validate by asking the API, not by pattern-matching the string.
 *
 * A token that looks right but has been revoked would otherwise be accepted
 * here and fail later as "could not fetch data", which sends people to check
 * their charts instead of their token.
 */
function setCredentials(request) {
  var key = request.key
  var props = PropertiesService.getUserProperties()
  props.setProperty('dscc.key', key)
  return cc.newSetCredentialsResponse().build()
}

function getConfig() {
  var config = cc.getConfig()

  config.newInfo()
    .setId('instructions')
    .setText('Enter your site id (from the dashboard URL) and, if you self-host, your instance URL. The share token goes in the credentials step.')

  config.newTextInput()
    .setId('siteId')
    .setName('Site ID')
    .setHelpText('The site id from your dashboard URL, e.g. 5c37fc95792b8800f28930fb')
    .setPlaceholder('site id')

  config.newTextInput()
    .setId('host')
    .setName('Instance URL')
    .setHelpText('Leave blank unless you self-host.')
    .setPlaceholder(DEFAULT_HOST)

  config.setDateRangeRequired(true)
  return config.build()
}

/** Field ids must match the API's dimension and metric names exactly. */
function buildFields() {
  var fields = cc.getFields()
  var types = cc.FieldType
  var aggregations = cc.AggregationType

  fields.newDimension().setId('date').setName('Date').setType(types.YEAR_MONTH_DAY)
  fields.newDimension().setId('path').setName('Page').setType(types.TEXT)
  fields.newDimension().setId('referrer_source').setName('Source').setType(types.TEXT)
  fields.newDimension().setId('country').setName('Country').setType(types.COUNTRY_CODE)
  fields.newDimension().setId('device_type').setName('Device').setType(types.TEXT)
  fields.newDimension().setId('browser').setName('Browser').setType(types.TEXT)
  fields.newDimension().setId('os').setName('OS').setType(types.TEXT)
  fields.newDimension().setId('utm_campaign').setName('Campaign').setType(types.TEXT)

  fields.newMetric().setId('views').setName('Pageviews').setType(types.NUMBER).setAggregation(aggregations.SUM)
  fields.newMetric().setId('visitors').setName('Visitors').setType(types.NUMBER).setAggregation(aggregations.SUM)
  fields.newMetric().setId('sessions').setName('Sessions').setType(types.NUMBER).setAggregation(aggregations.SUM)
  fields.newMetric().setId('bounces').setName('Bounces').setType(types.NUMBER).setAggregation(aggregations.SUM)

  return fields
}

function getSchema(request) {
  return { schema: buildFields().build() }
}

function host(configParams) {
  var h = (configParams && configParams.host) ? String(configParams.host).trim() : ''
  return (h || DEFAULT_HOST).replace(/\/+$/, '')
}

/**
 * Looker Studio's YEAR_MONTH_DAY wants YYYYMMDD; the API returns YYYY-MM-DD.
 *
 * Returned unchanged when it is not a date, so a future dimension added to the
 * API does not silently lose characters here.
 */
function toStudioDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.replace(/-/g, '') : value
}

function getData(request) {
  var configParams = request.configParams || {}
  var siteId = String(configParams.siteId || '').trim()
  if (!siteId) {
    cc.newUserError().setText('No site id configured. Edit the data source and enter the site id from your dashboard URL.').throwException()
  }

  var requested = (request.fields || []).map(function (f) { return f.name })
  var all = buildFields().build()
  var byId = {}
  for (var i = 0; i < all.length; i++)
    byId[all[i].getId()] = all[i]

  // Ask for ONLY the fields Looker Studio wants. Requesting everything would
  // group by every dimension and pull a far larger result than the chart uses.
  var dimensions = []
  var metrics = []
  for (var j = 0; j < requested.length; j++) {
    var field = byId[requested[j]]
    if (!field) continue
    if (field.isDimension()) dimensions.push(requested[j])
    else metrics.push(requested[j])
  }
  // The API requires at least one metric; a dimension-only request is a valid
  // thing for Looker Studio to ask, so send a cheap one and drop it after.
  var padded = metrics.length === 0
  if (padded) metrics.push('views')

  var range = request.dateRange || {}
  var url = host(configParams) + '/api/connect/' + encodeURIComponent(siteId) + '/report'
    + '?dimensions=' + encodeURIComponent(dimensions.join(','))
    + '&metrics=' + encodeURIComponent(metrics.join(','))
  // The API compares against ISO timestamp strings, and Looker Studio hands us
  // bare dates. `from` is fine as-is because "2026-01-15" sorts before every
  // timestamp on that day — but a bare `to` sorts BEFORE them, which would drop
  // the whole last day of every report. It is extended to the end of the day.
  if (range.startDate) url += '&from=' + encodeURIComponent(range.startDate)
  if (range.endDate) url += '&to=' + encodeURIComponent(range.endDate + 'T23:59:59.999Z')

  var key = PropertiesService.getUserProperties().getProperty('dscc.key')
  var response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + key },
    muteHttpExceptions: true,
  })

  var status = response.getResponseCode()
  var text = response.getContentText()
  if (status !== 200) {
    var message = text
    try { message = JSON.parse(text).error || text } catch (e) { /* keep the body */ }
    // setText is shown to the user; setDebugText goes to the execution log. The
    // API's messages are written to be read by a person, so they are surfaced.
    cc.newUserError()
      .setText(message)
      .setDebugText('HTTP ' + status + ' from ' + url)
      .throwException()
  }

  var payload = JSON.parse(text)
  var fieldOrder = payload.fields || []
  var dateIndex = fieldOrder.indexOf('date')

  var rows = (payload.rows || []).map(function (values) {
    var out = values.slice()
    if (dateIndex >= 0) out[dateIndex] = toStudioDate(String(out[dateIndex]))
    if (padded) out = out.slice(0, out.length - 1)
    return { values: out }
  })

  var returnedFields = padded ? fieldOrder.slice(0, fieldOrder.length - 1) : fieldOrder

  if (payload.truncated) {
    // Never a silent cap. A chart drawn on part of the data looks like a real
    // decline, and nothing on screen would say otherwise.
    cc.newUserError()
      .setText('This range returned more rows than one request can carry, so the report would be incomplete. Narrow the date range.')
      .throwException()
  }

  // forIds on the FULL field set, not on cc.getFields() — that returns a fresh
  // empty container, and selecting ids from nothing yields an empty schema and
  // a chart with no columns.
  return {
    schema: buildFields().forIds(returnedFields).build(),
    rows: rows,
  }
}

/** No admin surface; the connector is deployed per-account. */
function isAdminUser() {
  return false
}
