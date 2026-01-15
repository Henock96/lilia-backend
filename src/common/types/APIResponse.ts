/* eslint-disable prettier/prettier */
export class APIResponse {
  success: boolean;
  data: any;
  error: any;
  message: string | string[];
  statusCode : number;
}
