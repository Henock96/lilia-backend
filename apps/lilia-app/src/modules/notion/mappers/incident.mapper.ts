import { Incident } from '@prisma/client';
import { NotionProperties } from '../interfaces/notion-page.types';
import { NOTION_PROPS } from '../notion.constants';

const MAX_RICH_TEXT = 2000; // Notion rich_text max length per chunk

export function mapIncidentToNotion(incident: Incident): NotionProperties {
  const P = NOTION_PROPS.INCIDENTS;

  return {
    [P.TITLE]: { title: [{ text: { content: incident.title.slice(0, 200) } }] },
    [P.PRISMA_ID]: { rich_text: [{ text: { content: incident.id } }] },
    [P.TYPE]: { select: { name: incident.type } },
    [P.SEVERITY]: { select: { name: incident.severity } },
    [P.STATUS]: { select: { name: incident.status } },
    [P.DESCRIPTION]: {
      rich_text: [
        { text: { content: incident.description.slice(0, MAX_RICH_TEXT) } },
      ],
    },
    ...(incident.orderId
      ? {
          [P.ORDER_ID]: {
            rich_text: [{ text: { content: incident.orderId } }],
          },
        }
      : {}),
    ...(incident.riderId
      ? {
          [P.RIDER_ID]: {
            rich_text: [{ text: { content: incident.riderId } }],
          },
        }
      : {}),
    ...(incident.restaurantId
      ? {
          [P.RESTAURANT_ID]: {
            rich_text: [{ text: { content: incident.restaurantId } }],
          },
        }
      : {}),
    ...(incident.resolution
      ? {
          [P.RESOLUTION]: {
            rich_text: [
              {
                text: {
                  content: incident.resolution.slice(0, MAX_RICH_TEXT),
                },
              },
            ],
          },
        }
      : {}),
    [P.CREATED_AT]: { date: { start: incident.createdAt.toISOString() } },
    ...(incident.resolvedAt
      ? {
          [P.RESOLVED_AT]: {
            date: { start: incident.resolvedAt.toISOString() },
          },
        }
      : {}),
  };
}
