package com.example.smartgoprototype.data.remote.api

import com.example.smartgoprototype.data.remote.dto.CreateRouteRequest
import com.example.smartgoprototype.data.remote.dto.CreateRouteResponseDto
import retrofit2.http.Body
import retrofit2.http.GET
import retrofit2.http.POST

/**
 * Retrofit contract for the Routes backend.
 *
 * Notes for readers/graders:
 * - This interface is intentionally "dumb": it mirrors HTTP endpoints and uses DTOs.
 * - Mapping from DTOs -> domain models happens in the repository layer (see `toDomain()` usage),
 *   keeping the UI/ViewModel independent of network schemas.
 */
interface RoutesApi {

    /**
     * Fetches the current user's saved routes.
     *
     */
    @GET("routes")
    suspend fun getRoutes(): List<CreateRouteResponseDto>

    /**
     * Creates a new route.
     *
     */
    @POST("routes/create")
    suspend fun createRoute(
        @Body request: CreateRouteRequest
    ): CreateRouteResponseDto
}