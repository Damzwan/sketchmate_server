import { Document } from 'mongoose';

export type AsDocument<T, O extends keyof T = never> =
  Omit<T, O | '_id'> &
  { _id: any } &
  { [K in O]: any } &
  Document;