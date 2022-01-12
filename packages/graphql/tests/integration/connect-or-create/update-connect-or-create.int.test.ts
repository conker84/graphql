/*
 * Copyright (c) "Neo4j"
 * Neo4j Sweden AB [http://neo4j.com]
 *
 * This file is part of Neo4j.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { gql } from "apollo-server";
import { Driver, Session, Integer } from "neo4j-driver";
import { graphql, DocumentNode } from "graphql";
import neo4j from "../neo4j";
import { Neo4jGraphQL } from "../../../src";
import { generateUniqueType } from "../../utils/graphql-types";
import { getQuerySource } from "../../utils/get-query-source";

describe("Update -> ConnectOrCreate", () => {
    let driver: Driver;
    let session: Session;
    let typeDefs: DocumentNode;

    const typeMovie = generateUniqueType("Movie");
    const typeActor = generateUniqueType("Actor");

    let neoSchema: Neo4jGraphQL;

    beforeAll(async () => {
        driver = await neo4j();

        typeDefs = gql`
        type ${typeMovie.name} {
            title: String!
            id: Int! @unique
            ${typeActor.plural}: [${typeActor.name}!]! @relationship(type: "ACTED_IN", direction: IN, properties:"ActedIn")
        }

        type ${typeActor.name} {
            name: String
            ${typeMovie.plural}: [${typeMovie.name}!]! @relationship(type: "ACTED_IN", direction: OUT, properties:"ActedIn")
        }

        interface ActedIn {
            screentime: Int
        }
        `;

        neoSchema = new Neo4jGraphQL({ typeDefs });
    });

    beforeEach(() => {
        session = driver.session();
    });

    afterEach(async () => {
        await session.close();
    });

    afterAll(async () => {
        await driver.close();
    });

    test("Update with ConnectOrCreate creates new node", async () => {
        await session.run(`CREATE (:${typeActor.name} { name: "Tom Hanks"})`);

        const query = gql`
            mutation {
              ${typeActor.operations.update}(
                update: {
                    name: "Tom Hanks 2"
                    ${typeMovie.plural}: {
                      connectOrCreate: {
                        where: { node: { id: 5 } }
                        onCreate: { edge: { screentime: 105 }, node: { title: "The Terminal", id: 5 } }
                      }
                    }
                  }
                where: { name: "Tom Hanks"}
              ) {
                ${typeActor.plural} {
                  name
                }
              }
            }
            `;

        const gqlResult = await graphql({
            schema: neoSchema.schema,
            source: getQuerySource(query),
            contextValue: { driver, driverConfig: { bookmarks: [session.lastBookmark()] } },
        });
        expect(gqlResult.errors).toBeUndefined();
        expect((gqlResult as any).data[typeActor.operations.update][typeActor.plural]).toEqual([
            {
                name: "Tom Hanks 2",
            },
        ]);

        const movieTitleAndId = await session.run(`
          MATCH (m:${typeMovie.name} {id: 5})
          RETURN m.title as title, m.id as id
        `);

        expect(movieTitleAndId.records).toHaveLength(1);
        expect(movieTitleAndId.records[0].toObject().title).toEqual("The Terminal");
        expect((movieTitleAndId.records[0].toObject().id as Integer).toNumber()).toEqual(5);

        const actedInRelation = await session.run(`
            MATCH (:${typeMovie.name} {id: 5})<-[r:ACTED_IN]-(:${typeActor.name} {name: "Tom Hanks 2"})
            RETURN r.screentime as screentime
            `);

        expect(actedInRelation.records).toHaveLength(1);
        expect((actedInRelation.records[0].toObject().screentime as Integer).toNumber()).toEqual(105);
    });

    test("Update with ConnectOrCreate on existing node", async () => {
        const testActorName = "aRandomActor";
        const updatedActorName = "updatedActor";
        await session.run(`CREATE (m:${typeMovie.name} { title: "Terminator2", id: 2222})`);
        await session.run(`CREATE (:${typeActor.name} { name: "${testActorName}"})`);

        const query = gql`
            mutation {
              ${typeActor.operations.update}(
                update: {
                    name: "${updatedActorName}"
                    ${typeMovie.plural}: {
                      connectOrCreate: {
                        where: { node: { id: 2222 } }
                        onCreate: { edge: { screentime: 105 }, node: { title: "The Terminal", id: 22224 } }
                      }
                    }
                  }
                where: { name: "${testActorName}"}
              ) {
                ${typeActor.plural} {
                  name
                }
              }
            }
            `;

        const gqlResult = await graphql({
            schema: neoSchema.schema,
            source: getQuerySource(query),
            contextValue: { driver, driverConfig: { bookmarks: [session.lastBookmark()] } },
        });
        expect(gqlResult.errors).toBeUndefined();
        expect((gqlResult as any).data[typeActor.operations.update][`${typeActor.plural}`]).toEqual([
            {
                name: updatedActorName,
            },
        ]);

        const actorsWithMovieCount = await session.run(`
          MATCH (a:${typeActor.name} {name: "${updatedActorName}"})-[]->(m:${typeMovie.name} {id: 2222})
          RETURN COUNT(a) as count
        `);

        expect(actorsWithMovieCount.records[0].toObject().count.toInt()).toEqual(1);

        const moviesWithIdCount = await session.run(`
          MATCH (m:${typeMovie.name} {id: 2222})
          RETURN COUNT(m) as count
        `);

        expect(moviesWithIdCount.records[0].toObject().count.toInt()).toEqual(1);

        const theTerminalMovieCount = await session.run(`
          MATCH (m:${typeMovie.name} {id: 2222, name: "The Terminal"})
          RETURN COUNT(m) as count
        `);

        expect(theTerminalMovieCount.records[0].toObject().count.toInt()).toEqual(0);

        const actedInRelation = await session.run(`
            MATCH (:${typeMovie.name} {id: 2222})<-[r:ACTED_IN]-(:${typeActor.name} {name: "${updatedActorName}"})
            RETURN r.screentime as screentime
            `);

        expect(actedInRelation.records).toHaveLength(1);
        expect((actedInRelation.records[0].toObject().screentime as Integer).toNumber()).toEqual(105);

        const newIdMovieCount = await session.run(`
            MATCH (m:${typeMovie.name} {id: 22224})
            RETURN COUNT(m) as count
            `);
        expect(newIdMovieCount.records[0].toObject().count.toInt()).toEqual(0);
    });
});
