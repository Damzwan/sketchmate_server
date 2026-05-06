import { Document, Types } from 'mongoose';

export type AsDocument<T, O extends keyof T = never> =
  Omit<T, O | '_id'> &
  { _id: Types.ObjectId } &
  { [K in O]: T[K] extends Array<any> ? any[] : any } &
  Document;