package com.example.smartgoprototype.ui.addroute

import android.app.Activity
import android.content.Context
import android.content.Intent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import com.example.smartgoprototype.domain.model.GoogleAddressComponent
import com.example.smartgoprototype.domain.model.PlaceLocation
import com.google.android.libraries.places.api.Places
import com.google.android.libraries.places.api.model.AutocompleteSessionToken
import com.google.android.libraries.places.api.model.Place
import com.google.android.libraries.places.api.net.FetchPlaceRequest
import com.google.android.libraries.places.widget.PlaceAutocomplete
import com.google.android.libraries.places.widget.PlaceAutocompleteActivity

@Composable
fun rememberPlaceAutocompleteLauncher(
    context: Context,
    onSelected: (PlaceLocation) -> Unit,
    onError: (String) -> Unit = {}
): () -> Unit {
    val sessionToken = remember { AutocompleteSessionToken.newInstance() }
    val placesClient = remember { Places.createClient(context) }

    fun buildIntent(): Intent =
        PlaceAutocomplete.IntentBuilder()
            .setAutocompleteSessionToken(sessionToken)
            .build(context)

    val launcher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data

        when (result.resultCode) {
            PlaceAutocompleteActivity.RESULT_OK -> {
                if (data == null) return@rememberLauncherForActivityResult
                val prediction = PlaceAutocomplete.getPredictionFromIntent(data)
                if (prediction == null) {
                    onError("No prediction returned.")
                    return@rememberLauncherForActivityResult
                }

                val placeId = prediction.placeId
                val label = prediction.getFullText(null)?.toString()
                    ?: prediction.getPrimaryText(null)?.toString()
                    ?: placeId

                val fields = listOf(
                    Place.Field.ADDRESS_COMPONENTS
                )

                val request = FetchPlaceRequest.builder(placeId, fields)
                    .setSessionToken(sessionToken)
                    .build()

                placesClient.fetchPlace(request)
                    .addOnSuccessListener { response ->
                        val place = response.place
                        val comps = place.addressComponents?.asList()
                            ?.mapNotNull { c ->
                                val sanitizedTypes = c.types.filter { it.isNotBlank() }
                                if (sanitizedTypes.isEmpty()) return@mapNotNull null
                                GoogleAddressComponent(
                                    longText = c.name,
                                    shortText = c.shortName,
                                    types = sanitizedTypes
                                )
                            }
                            .orEmpty()

                        onSelected(
                            PlaceLocation(
                                placeId = placeId,
                                label = label,
                                addressComponents = comps
                            )
                        )
                    }
                    .addOnFailureListener { e ->
                        onError(e.message ?: "Failed to fetch place details.")
                    }
            }

            PlaceAutocompleteActivity.RESULT_ERROR -> {
                val status = data?.let { PlaceAutocomplete.getResultStatusFromIntent(it) }
                onError(status?.statusMessage ?: "Autocomplete error.")
            }

            Activity.RESULT_CANCELED -> Unit
        }
    }

    return { launcher.launch(buildIntent()) }
}
