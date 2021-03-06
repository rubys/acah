#!/usr/bin/env node
const fs = require('fs').promises;
const path = require('path');
const deepEqual = require('deep-equal');

const root = process.cwd();
const input = `${root}/tracks`;
const output = `${root}/calendars`;

let { parse, serialize } = require('@rubys/ical');

const location = '@home';

// handle unhandledRejections
process.on('unhandledRejection', (reason, promise) => (
  console.log(reason.stack || reason)
));

(async () => {

  // keep track of the calendars produced
  let calendars = new Set();

  // a list of all events for the conference
  let allEvents = [];

  // iterate over all of the files in the tracks directory
  for (let track of await fs.readdir(input, 'utf8')) {

    // ignore a few files
    if (!track.endsWith('.html') || track === 'template.html' || track === 'index.html') continue;

    // read the file
    let page = await fs.readFile(`${input}/${track}`, 'utf8');

    // extract the category from the title, falling back to the file name stem.
    let category = (page.match(/<title>ApacheCon @Home - (.*?)( Track)?<\/title>/) || [])[1];
    if (!category || category === 'PROJECT') {
      console.error(`Missing or incorrect <title>: ${track}`);
      category = track.split('.')[0];
    }

    // split page into sessions
    let sessions = []
    let splits = [...page.matchAll(/<strong><a\s+href="https:\/\/www.timeanddate.com/g)];
    if (splits.length) {
      let start = splits.shift().index;
      for (let split of splits) {
        sessions.push(page.slice(start, split.index));
        start = split.index;
      }
      sessions.push(page.slice(start, page.lastIndexOf('</section>')));
    }

    // prefix for output file name
    let prefix = track.split('.')[0];

    // collect a list of events for this track
    let events = [];

    // list of used ids in this track
    let ids = {};

    for (let session of sessions) {
      // scrape HTML for data
      let headers = [...session.matchAll(/<strong>\s*(.*?)\s*<\/strong>/gs)];
      let summary = headers[1][1];
      let id = (session.match(/<a name="(\w\d+)">/) || [])[1];
      let start = (session.match(/\?iso=([-\dT:]+)/) || [])[1];
      let htmlDescription = session.slice((headers[2] || {}).index || session.length).trim();

      // invalid dates cause the session to be skipped
      if (!start || start.length !== 19) {
        console.error(`Bad start time: ${prefix} ${id || summary}`);
        continue;
      }
      start += 'Z';

      // generate ids when one can't be found
      if (!id) {
        let date = new Date(start);
        id = 'UMTWRFS'[date.getDay()] + date.getHours().toString().padStart(2, '0') + date.getMinutes().toString().padStart(2, '0');
        console.error(`Bad anchor: ${prefix}-${id}`);
      }

      // if id has already been taken, add a suffix
      if (ids[id]) {
        ids[id]++;
        id += '-' + ids[id];
      } else {
        ids[id] = 1;
      }

      // if necessary, back up to last <br> for start of html
      if (htmlDescription === '') {
        let lastBr = [...session.matchAll(/<br\s*\/?>/g)].pop();
        htmlDescription = session.slice(lastBr.index + lastBr[0].length).trim();
        console.error(`Missing <strong> entry: ${prefix}-${id}`);
      }

      // set end 40 minutes after beginning
      let end = new Date(new Date(start).getTime() + 40 * 60 * 1000).toISOString().replace('.000Z', 'Z');

      // determine uid and fileName
      let uid = `acah2020-${prefix}-${id}@apachecon.com`;
      let fileName = `${output}/${prefix}-${id}.ics`;
      let url = `https://apachecon.com/acah2020/tracks/${prefix}.html#${id}`

      // build and track event
      let event = { categories: [{ name: category }], uid, start, end, summary, htmlDescription, location, url };
      events.push(event);
      calendars.add(path.basename(fileName));

      // if there was a previous version of this entry, copy the stamp
      // and sequence to the new entry.  If the updated new entry
      // matches the previous entry, abort further processing of this
      // entry, otherwise increment the sequence number.
      try {
        let ics = await fs.readFile(fileName, 'utf8');

        let previous = parse(ics).events[0];
        let { sequence, stamp } = previous;
        event.sequence = sequence;
        event.stamp = stamp;
        if (deepEqual(previous, event)) {
          continue;
        } else {
          event.sequence++;
        };
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }

      // write out the new or changed entry
      let ics = serialize({ calendar: { name: `${prefix}-${id}` }, events: [event] });
      await fs.writeFile(fileName, ics, 'utf8');
    }

    // add track events to the conference
    allEvents.push(...events);

    // determine and track name of whole track calendar
    let fileName = `${output}/${prefix}.ics`;
    calendars.add(path.basename(fileName));
    let ics = serialize({ calendar: { name: category }, events });

    // if the calendar hasn't changed, skip update
    try {
      let previous = await fs.readFile(fileName, 'utf8');
      if (ics === previous) continue;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }

    // add/update whole track calendar
    await fs.writeFile(fileName, ics, 'utf8');

  }

  // generate a global calendar
  let fileName = `${output}/global.ics`;
  let ics = serialize({ calendar: { name: 'ApacheCon 2020' }, events: allEvents });
  calendars.add(path.basename(fileName));

  // update only if the calendar has changed, skip update
  try {
    let previous = await fs.readFile(fileName, 'utf8');
    if (ics !== previous) await fs.writeFile(fileName, ics, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await fs.writeFile(fileName, ics, 'utf8')
  }

  // remove any calendars that are no longer in the input
  for (let file of await fs.readdir(output, 'utf8')) {
    if (file.endsWith('.ics') && !calendars.delete(file)) {
      await fs.unlink(`${output}/${file}`);
    }
  }

})();
